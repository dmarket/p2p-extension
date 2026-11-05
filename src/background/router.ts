import { getUpdateStatus } from '@/background/forceUpdate';
import { reportError } from '@/infra/report/reporter';
import { Tracker, type TrackerHandle } from '@/core/tracker';
import { isBridgeRequest, type BridgeRequest, type BridgeResponse } from '@/messaging/protocol';
import { isActivated } from '@/state/activation';
import { DMARKET_ORIGINS, getSettings } from '@/config/settings';
import { extensionVersion } from '@/util/extensionVersion';
import { fromSteamTab } from '@/background/steamSender';
import {
  forgetTrustedPartner,
  forgetRetractedScamPartners,
  keepOnlyListed,
  readScanStamp,
  readVerdicts,
  recordPageImpersonations,
  restoreReported,
  settledScanStamp,
  watchScanStamp,
} from '@/background/offerGuard';
import { getBlockingReason } from '@/state/blocking';
import { resolveSurface } from '@/state/surface';
import {
  isOfferVerdictsRequest,
  isTrustPartnerRequest,
  STEAM_ID64,
  type GuardResponse,
  type OfferVerdict,
  type OfferVerdictsRequest,
} from '@/state/offerGuard';

// How long a create-trade request waits for its deal's directive: the core's POST /create-trade round trip plus
// the Steam POST. Past it the page is answered `create_in_flight` while the cycle carries on, and its retry is
// answered from the deal's claim, so a slow cycle cannot become a second offer.
const CREATE_TRADE_WAIT_MS = 30_000;

// A warm spawn boots in one storage read, so only a first install or a failed boot ever reaches this
// cap. The wait ends as soon as the handle exists.
const PRESENCE_BOOT_WAIT_MS = 1_000;

/** Wait for `settled`, but never longer than `ms`. Clears its timer — presence is pinged often. */
function withCap(settled: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void settled.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function wakeAll(reason?: 'offers_page'): string {
  return JSON.stringify({ type: 'wake_all', reason });
}

function wakeDeal(dealId: string): string {
  return JSON.stringify({ type: 'wake_deal', dealId });
}

// When a presence ping arrives while we're blocked on DM_SESSION_MISSING, we force an immediate
// heartbeat (bypassing the ttl gate) to re-check the DMarket session — this is how a fresh login clears
// the "no DMarket connection" prompt now instead of on the next scheduled cycle. Throttled AND
// guarded against pile-up: the FE pings presence often, a forced heartbeat is a network POST, and while
// disconnected it may be slow. Seeded to "now" (not 0): this nudge only fires when the in-memory
// reason is DM_SESSION_MISSING, and a blocked state never advances the persisted heartbeat schedule
// (core ≥ .104) — so whenever we're genuinely blocked, a fresh worker's boot cycle is already due and
// heartbeating; a presence ping in that boot window would only stack a redundant forced POST on top.
const RECONNECT_DEBOUNCE_MS = 3_000;
let lastReconnectAt = Date.now();
let reconnectInFlight = false;

/**
 * `getHandle`, not a handle: the create-trade branch now awaits the activation flag before it needs one,
 * and a handle snapshotted before that yield can be a core a Remote Config publish or a debug endpoint
 * switch has since replaced. Each branch reads it at the point it is entitled to.
 */
async function handle(request: BridgeRequest, getHandle: () => TrackerHandle | undefined): Promise<BridgeResponse> {
  switch (request.kind) {
    case 'presence': {
      // Snapshotted ONCE for this branch: the two core reads below must describe the same core, or one
      // pong could carry a blocking reason from one handle and a tracking flag from another.
      const tracker = getHandle();
      // Answerable from glue + the core state — never expose device_id, credentials, or the held
      // token's Steam id. `blockingReason()` / `isTrackingActive()` are cheap in-memory reads (cached
      // from the last heartbeat); fail-open (`'NONE'` / not active) when the tracker isn't up. The FE
      // wire contract keeps the boolean `mismatch` (backward-compatible: only a Steam-account mismatch
      // maps to it; DM_SESSION_MISSING is handled by the extension's own UI) and now also carries
      // `is_activated` (the host-owned onboarding flag) + `is_tracking_active`. NOTE: we deliberately do
      // NOT persist here — onLifecycleEvent already keeps state/blocking.ts fresh on every heartbeat, and
      // blockingReason() only changes on a heartbeat; `isActivated()` below is a read-only storage.get
      // (no write), so a presence ping never triggers a storage.onChanged storm (the FE pings often).
      let reason: ReturnType<typeof Tracker.blockingReason> = 'NONE';
      let coreUnblocked = false;
      if (tracker !== undefined) {
        try {
          reason = Tracker.blockingReason(tracker);
          coreUnblocked = Tracker.isTrackingActive(tracker);
        } catch {
          /* handle not ready — treat as not blocked / not active (fail-open) */
        }
      }
      // If we're blocked on a missing DMarket connection, use this ping as the trigger to force an
      // immediate heartbeat (bypassing the ttl gate) so a fresh login clears the block now instead of on
      // the next scheduled cycle. Fire-and-forget: the pong returns right away, and the ensuing
      // HeartbeatSent/CycleCompleted event re-reads blockingReason() → persisted NONE, which clears the
      // popup/icon (see background.ts onLifecycleEvent). Debounced + in-flight-guarded so frequent pings
      // (and a slow POST while offline) can't pile up forced heartbeats.
      if (tracker !== undefined && reason === 'DM_SESSION_MISSING' && !reconnectInFlight) {
        const now = Date.now();
        if (now - lastReconnectAt >= RECONNECT_DEBOUNCE_MS) {
          lastReconnectAt = now;
          reconnectInFlight = true;
          void Tracker.forceHeartbeat(tracker)
            .catch(() => {})
            .finally(() => {
              reconnectInFlight = false;
            });
        }
      }
      // Tracking counts as "active" only when the user has turned the extension on AND the core is
      // unblocked (DMarket session usable + on the linked Steam account). If the extension isn't
      // activated we don't let the user track with it, so this is false regardless of core state.
      const activated = await isActivated();
      return {
        ok: true,
        kind: 'presence',
        version: extensionVersion(),
        mismatch: reason === 'STEAM_ACCOUNT_MISMATCH',
        isActivated: activated,
        isTrackingActive: activated && coreUnblocked,
        // Already resolved above for the reconnect trigger — the page needs it to name the failed
        // check instead of inferring one from two booleans.
        blockingReason: reason,
        // Independent of activation and of the core: an un-onboarded install on an old build must still be
        // told to update.
        update: await getUpdateStatus(),
      };
    }

    case 'create-trade': {
      // The activation gate, and it comes FIRST for two reasons. It is a REFUSAL, not a "not ready yet":
      // nothing changes until the user completes onboarding, so `EXT_NOT_READY` — which tells the page to
      // retry once the tracker is up — would leave it retrying forever. And now that the core itself is
      // gated on activation (src/background/coreLifecycle.ts), a missing handle is the ORDINARY state for
      // an un-onboarded install, so checking the handle first would answer every one of them with a code
      // that means something else. Nothing reaches Steam on this path either way.
      if (!(await isActivated())) {
        return { ok: false, error: 'extension not activated', reason: 'EXT_NOT_ACTIVATED' };
      }
      // Read AFTER that await, never before it. A core replaced while the flag was being read would
      // otherwise have this write land on the stopped one and fail a create that the live replacement
      // would have completed.
      const tracker = getHandle();
      // Coded: the page distinguishes "the tracker is not running" (retry once it is) from a Steam
      // refusal, and a caller must never have to pattern-match this string to find that out.
      if (tracker === undefined) return { ok: false, error: 'tracker not started', reason: 'EXT_NOT_READY' };
      // A trigger only: the core fetches the backend's own create_offer directive for this deal and runs it with
      // the account binding from the last heartbeat. The page's message carried nothing else in.
      const result = await Tracker.awaitDirectiveOutcome(tracker, request.dealId, CREATE_TRADE_WAIT_MS);
      return { ok: true, kind: 'create-trade', result };
    }

    case 'request-cycle': {
      const tracker = getHandle();
      if (tracker === undefined) return { ok: false, error: 'tracker not started' };
      // The reason is passed on only when it is the one value the core knows; the message is not page data,
      // but nothing else needs to reach the push parser.
      const reason = request.reason === 'offers_page' ? request.reason : undefined;
      await Tracker.deliverPush(tracker, request.dealId ? wakeDeal(request.dealId) : wakeAll(reason));
      return { ok: true, kind: 'request-cycle' };
    }
  }
}

/**
 * Presence waits for the boot; writes do not.
 *
 * The router is registered on every spawn, but the handle only exists once `bootCore()` finishes. Asked
 * in between, the presence branch answers `is_activated: true` with `is_tracking_active: false` and
 * `blocking_reason: 'NONE'`, which contradicts itself and fails closed where the core fails open. Chrome
 * kills an idle worker after ~30s, so a quiet page usually got that answer, too fast for any page-side
 * timeout to help. `create-trade` has a coded `EXT_NOT_READY` for a missing core and `request-cycle` is
 * worthless a second late, so neither of them waits.
 *
 * `bootSettled` resolves however the boot ends, so a failed boot answers instead of stalling every ping.
 * An endpoint restart clears the handle for a moment and a ping there still gets the defaults; re-arming
 * the gate could hang on a restart that never finishes.
 */
async function answer(
  request: BridgeRequest,
  getHandle: () => TrackerHandle | undefined,
  bootSettled: Promise<void>,
): Promise<BridgeResponse> {
  if (request.kind === 'presence') await withCap(bootSettled, PRESENCE_BOOT_WAIT_MS);
  return handle(request, getHandle);
}

/**
 * Debug builds also inject the bridge on the dev/stage FE (the `build:manifestGenerated` hook in wxt.config.ts)
 * and on the FE origins the debug console applied (`debug.allowedOrigins`, src/debug/feBridge.ts). The key is a
 * literal, as in background.ts, so this compile-time-dead branch pulls nothing from src/debug into production.
 */
async function devFeOrigins(): Promise<string[]> {
  if (!import.meta.env.DEV) return [];
  const out: string[] = [];
  for (const url of [import.meta.env.WXT_DEV_FE_URL, import.meta.env.WXT_STAGE_FE_URL]) {
    try {
      if (url?.trim()) out.push(new URL(url.trim()).origin);
    } catch {
      /* an unparseable .env value adds nothing, as in the manifest hook */
    }
  }
  try {
    const stored = (await browser.storage.local.get('debug.allowedOrigins'))['debug.allowedOrigins'];
    if (Array.isArray(stored)) for (const o of stored) if (typeof o === 'string') out.push(o.replace(/\/+$/, ''));
  } catch {
    /* storage unavailable — the build-time origins still count */
  }
  return out;
}

/**
 * Only this extension's own contexts may reach the bridge, and the page-facing kinds only from a tab on a
 * DMarket origin — the same origins the bridge content script is injected into. Without it any extension
 * context (the Steam content script included) could ask for `create-trade`. `request-cycle` carries no page
 * data and only nudges a cycle, so it needs the id check alone.
 */
async function senderAllowed(request: BridgeRequest, sender: Browser.runtime.MessageSender): Promise<boolean> {
  if (sender.id !== browser.runtime.id) return false;
  if (request.kind === 'request-cycle') return true;
  let origin: string;
  try {
    origin = new URL(sender.tab?.url ?? sender.url ?? '').origin;
  } catch {
    return false;
  }
  return DMARKET_ORIGINS.includes(origin) || (await devFeOrigins()).includes(origin);
}

/**
 * Register the service-worker message router for the dmarket.com bridge. Must be called synchronously
 * on every worker spawn. `getHandle` returns the current tracker handle (undefined if boot failed);
 * `bootSettled` is the entrypoint's boot promise — see {@link answer} for which requests wait on it.
 * `onPresence` runs on every presence ping, before the answer and without delaying it.
 */
export function registerBridgeRouter(
  getHandle: () => TrackerHandle | undefined,
  bootSettled: Promise<void>,
  onPresence?: () => void,
): void {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isBridgeRequest(message)) return undefined;
    void senderAllowed(message, sender).then((allowed) => {
      if (!allowed) {
        sendResponse({ ok: false, error: 'sender not allowed', reason: 'OTHER' } satisfies BridgeResponse);
        return;
      }
      if (message.kind === 'presence') onPresence?.();
      return answer(message, getHandle, bootSettled)
        .then(sendResponse)
        .catch((error) => {
          // Reported as an exception CLASS plus the request kind — never `String(error)`.
          //
          // Every argument on this path is page-controlled: `isFrontendMessage` only checks `typeof ===
          // 'string'`, so a rogue script or an XSS on dmarket.com can put a chosen value into `deal_id`, and it
          // can resurface inside a failure message. Echoing
          // that would hand the page a persisted, retried channel into the analytics warehouse, sent from the
          // extension's own context and invisible to the page itself. It is also charged to a separate, much
          // smaller daily budget (`fromPage`) so it cannot exhaust the internal one and blind the reporter.
          const name = error instanceof Error ? error.constructor.name : typeof error;
          reportError(new Error(`bridge ${message.kind} failed: ${name}`), { fromPage: true });
          sendResponse({ ok: false, error: String(error) } satisfies BridgeResponse);
        });
    });
    return true; // keep the message channel open for the async response
  });
}

async function offerVerdicts(
  request: OfferVerdictsRequest,
  getHandle: () => TrackerHandle | undefined,
): Promise<GuardResponse> {
  await forgetRetractedScamPartners(getSettings().web.knownScamPartners, false);
  if (request.pageComplete) await keepOnlyListed(request.offerIds);
  if (request.listed !== undefined) await restoreReported(request.listed);
  if (request.impersonations !== undefined) await recordPageImpersonations(request.impersonations);
  const [all, activated, reason, scanStamp] = await Promise.all([
    readVerdicts(),
    isActivated(),
    getBlockingReason(),
    readScanStamp(),
  ]);
  const coreRunning = getHandle() !== undefined && resolveSurface(activated, reason) === 'ACTIVE';
  const onPage = new Set(request.offerIds);
  const pick = (keep: (id: string, v: OfferVerdict) => boolean) =>
    Object.fromEntries(Object.entries(all).filter(([id, v]) => keep(id, v)));
  return {
    ok: true,
    verdicts: pick((id) => onPage.has(id)),
    scannedAt: settledScanStamp(scanStamp, all),
    coreRunning,
    // Debug builds only: offers the console simulated that have no block on this page.
    ...(import.meta.env.DEV ? { simulated: pick((id, v) => !onPage.has(id) && v.simulated !== undefined) } : {}),
  };
}

async function trustPartner(steamId: string): Promise<GuardResponse> {
  if (!STEAM_ID64.test(steamId)) return { ok: false, error: 'not a steamid64' };
  try {
    await Tracker.trustPartner(steamId);
  } catch (error) {
    reportError(error);
  }
  // Even when the core refused: the warning the user dismissed must go now, and the core keeps deciding
  // whether it comes back.
  await forgetTrustedPartner(steamId);
  return { ok: true };
}

/**
 * The suspicious-offer guard's messages from the Steam trade-offers content script: which of the page's offers
 * are suspicious, and "I know this partner". Only this extension's content script on a Steam community tab may
 * ask. Also tells those tabs when a check finishes (watchScanStamp). Must be called synchronously on every worker
 * spawn.
 */
export function registerOfferGuardRouter(getHandle: () => TrackerHandle | undefined): void {
  watchScanStamp();
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const verdicts = isOfferVerdictsRequest(message);
    if (!verdicts && !isTrustPartnerRequest(message)) return undefined;
    if (!fromSteamTab(sender)) {
      sendResponse({ ok: false, error: 'sender not allowed' } satisfies GuardResponse);
      return undefined;
    }
    const answer = verdicts ? offerVerdicts(message, getHandle) : trustPartner(message.steamId);
    answer.then(sendResponse, () => sendResponse({ ok: false, error: 'guard failed' } satisfies GuardResponse));
    return true;
  });
}
