import { reportError } from '@/infra/report/reporter';
import { Tracker, type TrackerHandle } from '@/core/tracker';
import { isBridgeRequest, type BridgeRequest, type BridgeResponse } from '@/messaging/protocol';
import { isActivated } from '@/state/activation';
import { getSettings } from '@/config/settings';

function wakeAll(): string {
  return JSON.stringify({ type: 'wake_all' });
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
// Debounce window is remote-config-tunable (web.reconnectDebounceMs, default 3000); read at use time.
let lastReconnectAt = Date.now();
let reconnectInFlight = false;

async function handle(request: BridgeRequest, tracker: TrackerHandle | undefined): Promise<BridgeResponse> {
  switch (request.kind) {
    case 'presence': {
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
        if (now - lastReconnectAt >= getSettings().web.reconnectDebounceMs) {
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
        version: Tracker.version(),
        mismatch: reason === 'STEAM_ACCOUNT_MISMATCH',
        isActivated: activated,
        isTrackingActive: activated && coreUnblocked,
        // Already resolved above for the reconnect trigger — the page needs it to name the failed
        // check instead of inferring one from two booleans.
        blockingReason: reason,
      };
    }

    case 'create-trade': {
      // Coded: the page distinguishes "the tracker is not running" (retry once it is) from a Steam
      // refusal, and a caller must never have to pattern-match this string to find that out.
      if (tracker === undefined) return { ok: false, error: 'tracker not started', reason: 'EXT_NOT_READY' };
      // The wrong-account guard runs INSIDE the core before any Steam write; on a mismatch nothing is
      // written and the result is account_mismatch. No create is attempted on the TS side.
      const result = await Tracker.createTrade(tracker, {
        directiveId: request.directiveId,
        dealId: request.dealId,
        partnerSteamId: request.partnerSteamId,
        assetIds: request.assetIds,
        tradeToken: request.tradeToken,
        linkedSteamId: request.linkedSteamId,
      });
      return { ok: true, kind: 'create-trade', result };
    }

    case 'request-cycle': {
      if (tracker === undefined) return { ok: false, error: 'tracker not started' };
      await Tracker.deliverPush(tracker, request.dealId ? wakeDeal(request.dealId) : wakeAll());
      return { ok: true, kind: 'request-cycle' };
    }
  }
}

/**
 * Register the service-worker message router for the dmarket.com bridge. Must be called synchronously
 * on every worker spawn. `getHandle` returns the current tracker handle (undefined if boot failed).
 */
export function registerBridgeRouter(getHandle: () => TrackerHandle | undefined): void {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isBridgeRequest(message)) return undefined;
    handle(message, getHandle())
      .then(sendResponse)
      .catch((error) => {
        // Reported as an exception CLASS plus the request kind — never `String(error)`.
        //
        // Every argument on this path is page-controlled: `isFrontendMessage` only checks `typeof ===
        // 'string'`, so a rogue script or an XSS on dmarket.com can put chosen values into `deal_id`,
        // `asset_ids`, `trade_token` and the rest, and they can resurface inside a failure message. Echoing
        // that would hand the page a persisted, retried channel into the analytics warehouse, sent from the
        // extension's own context and invisible to the page itself. It is also charged to a separate, much
        // smaller daily budget (`fromPage`) so it cannot exhaust the internal one and blind the reporter.
        const name = error instanceof Error ? error.constructor.name : typeof error;
        reportError(new Error(`bridge ${message.kind} failed: ${name}`), { fromPage: true });
        sendResponse({ ok: false, error: String(error) } satisfies BridgeResponse);
      });
    return true; // keep the message channel open for the async response
  });
}
