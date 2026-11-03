// The service worker's half of the suspicious-offer guard: keeps the latest verdict per Steam offer, sent or
// received, in `storage.session` (src/state/offerGuard.ts) and tells open trade-offers tabs when it changes.
//
// Verdicts come from the core's `SuspiciousOutgoingOffers` event (and, in a debug build, from the console's
// simulation, which sends the same event). The core reports an offer once per level and names in `cleared` the
// ones a later Steam read listed and no longer flags. Entries leave the cache that way, by VERDICT_TTL_MS, or,
// for the yellow sent ones and those only the page found, by a scan of the full sent-offers page that no longer
// lists them. Nothing here touches the offer itself.

import { STEAM_INTEGRATION } from '@/config/steam';
import { onStorageChanged } from '@/util/storageEvents';
import {
  GUARD_CHANGED_KIND,
  GUARD_SCANNED_AT_KEY,
  GUARD_VERDICTS_KEY,
  isOfferLevel,
  parseScanStamp,
  parseVerdicts,
  type OfferDirection,
  type OfferVerdict,
  type OfferVerdicts,
  type PageImpersonation,
} from '@/state/offerGuard';

/** As long as the core's own create lease: past it a real deal has its `steamOfferId`, or is long closed. */
export const VERDICT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A received offer stays open on Steam for up to 14 days, and no page re-derives its warning, while the core
 * reports it only once: dropped sooner, a live scam offer would lose its warning. The core's `cleared` takes it
 * down once the offer is no longer active.
 */
export const RECEIVED_VERDICT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export async function readVerdicts(now = Date.now()): Promise<OfferVerdicts> {
  const stored = await browser.storage.session.get(GUARD_VERDICTS_KEY);
  const all = parseVerdicts(stored[GUARD_VERDICTS_KEY]);
  return Object.fromEntries(
    Object.entries(all).filter(
      ([, v]) => now - v.at < (v.direction === 'received' ? RECEIVED_VERDICT_TTL_MS : VERDICT_TTL_MS),
    ),
  );
}

let chain: Promise<unknown> = Promise.resolve();

/** Read-modify-write, serialised so two events landing together cannot drop one another. */
function update(change: (verdicts: OfferVerdicts) => OfferVerdicts, now = Date.now()): Promise<void> {
  const run = chain.then(async () => {
    const before = await readVerdicts(now);
    const after = change({ ...before });
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    await browser.storage.session.set({ [GUARD_VERDICTS_KEY]: after });
    await notifyTabs();
  });
  chain = run.catch(() => {});
  return run;
}

/**
 * How long a new check stamp waits before it counts as finished. The core writes the stamp, then asks the Steam
 * Web API for the partners' names, and only then reports the suspicious offers, so a page that took the stamp
 * at once would show "nothing found" for that round trip and the banner after it.
 * shortcut: a names lookup slower than this still leaves that gap; a core event at the end of a check would close it.
 */
export const SCAN_SETTLE_MS = 5_000;

export async function readScanStamp(): Promise<number | null> {
  const stored = await browser.storage.local.get(GUARD_SCANNED_AT_KEY);
  return parseScanStamp(stored[GUARD_SCANNED_AT_KEY]);
}

/**
 * The stamp to show a page: once SCAN_SETTLE_MS has passed, or sooner when a verdict recorded after it shows the
 * check has already reported. `null` while the check may still be reporting.
 */
export function settledScanStamp(stamp: number | null, verdicts: OfferVerdicts, now = Date.now()): number | null {
  if (stamp === null) return null;
  if (now - stamp >= SCAN_SETTLE_MS) return stamp;
  return Object.values(verdicts).some((v) => v.at >= stamp) ? stamp : null;
}

/**
 * Tell open trade-offers tabs when the core finishes a sent-offers check, even one that found nothing new, so a
 * page showing "checking" can stop. Once per new stamp, SCAN_SETTLE_MS after it. Must be called synchronously on
 * every worker spawn.
 */
export function watchScanStamp(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return onStorageChanged((changes, area) => {
    const change = changes[GUARD_SCANNED_AT_KEY];
    if (area !== 'local' || change === undefined || change.newValue === change.oldValue) return;
    clearTimeout(timer);
    timer = setTimeout(() => void notifyTabs(), SCAN_SETTLE_MS);
  });
}

/** Best-effort: a tab without our content script (or closed meanwhile) just rejects. */
async function notifyTabs(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ url: [...STEAM_INTEGRATION.tradeOffersMatchPatterns] });
    await Promise.all(
      tabs
        .map((t) => t.id)
        .filter((id): id is number => id !== undefined)
        .map((id) => browser.tabs.sendMessage(id, { kind: GUARD_CHANGED_KIND }).catch(() => {})),
    );
  } catch {
    /* no matching tabs */
  }
}

interface WireOffer {
  offerId?: unknown;
  partnerSteamId?: unknown;
  level?: unknown;
  assetIdsGiven?: unknown;
  personaName?: unknown;
  /** `SENT` or `RECEIVED`; a core before DMA-819 reads sent offers only and leaves it out. */
  direction?: unknown;
  /** `true` on a received impersonation the core flagged on the sender's name, not its known-scam list. */
  byName?: unknown;
  /** Debug simulation only: the name the stand-in block shows. */
  simulatedPersonaName?: unknown;
}

/** The parts of a `SuspiciousOutgoingOffers` frame the cache reads. */
export interface SuspiciousOffersFrame {
  offers?: unknown;
  /** Offer ids the core no longer flags; a core before DMA-819 sends none. */
  cleared?: unknown;
}

function wireDirection(d: unknown): OfferDirection {
  return d === 'RECEIVED' ? 'received' : 'sent';
}

/** Cache the offers of one `SuspiciousOutgoingOffers` event and drop the ones it clears. Malformed entries are skipped. */
export function recordSuspiciousOffers(frame: SuspiciousOffersFrame, now = Date.now()): Promise<void> {
  const offers = Array.isArray(frame.offers) ? (frame.offers as WireOffer[]) : [];
  // A core that sends `cleared` sends it on every frame, empty or not; an older one never does.
  const clearable = Array.isArray(frame.cleared);
  const cleared = clearable ? (frame.cleared as unknown[]).filter((id): id is string => typeof id === 'string') : [];
  const parsed: [string, OfferVerdict][] = [];
  for (const o of offers) {
    if (typeof o !== 'object' || o === null) continue;
    if (typeof o.offerId !== 'string' || !/^\d+$/.test(o.offerId)) continue;
    if (typeof o.partnerSteamId !== 'string' || !isOfferLevel(o.level)) continue;
    const verdict: OfferVerdict = {
      level: o.level,
      direction: wireDirection(o.direction),
      partnerSteamId: o.partnerSteamId,
      giveCount: Array.isArray(o.assetIdsGiven) ? o.assetIdsGiven.length : 0,
      at: now,
      ...(typeof o.personaName === 'string' ? { personaName: o.personaName } : {}),
      ...(o.byName === true ? { byName: true as const } : {}),
      ...(clearable ? { clearable: true as const } : {}),
    };
    // A production build ignores the field: only the debug console's simulation may ask for a stand-in block.
    if (import.meta.env.DEV && typeof o.simulatedPersonaName === 'string') {
      verdict.simulated = { personaName: o.simulatedPersonaName };
    }
    parsed.push([o.offerId, verdict]);
  }
  if (parsed.length === 0 && cleared.length === 0) return Promise.resolve();
  return update((v) => {
    for (const id of cleared) delete v[id];
    return { ...v, ...Object.fromEntries(parsed) };
  }, now);
}

/**
 * Offers the Steam page itself recognised as impersonations. A cached offer keeps every other field, `at`
 * included, so the page reporting the same offer on every refresh writes nothing and wakes no tab. One the core
 * never reported red is marked `fromPage`: the core will not take back a level it never set, so nothing but the
 * page can (see keepOnlyListed).
 */
export function recordPageImpersonations(offers: readonly PageImpersonation[], now = Date.now()): Promise<void> {
  if (offers.length === 0) return Promise.resolve();
  return update((v) => {
    for (const o of offers) {
      const existing = v[o.offerId];
      v[o.offerId] = existing
        ? { ...existing, level: 'IMPERSONATION', ...(existing.level === 'IMPERSONATION' ? {} : { fromPage: true as const }) }
        : {
            level: 'IMPERSONATION',
            direction: 'sent',
            partnerSteamId: o.partnerSteamId,
            giveCount: o.giveCount,
            at: now,
            fromPage: true,
          };
    }
    return v;
  }, now);
}

/** The user knows this partner: drop the give-only warnings of offers sent to it. An impersonation stays. */
export function forgetTrustedPartner(steamId: string): Promise<void> {
  return update((v) =>
    Object.fromEntries(
      Object.entries(v).filter(
        ([, x]) => !(x.partnerSteamId === steamId && x.level === 'UNLINKED_GIVE_ONLY' && x.direction === 'sent'),
      ),
    ),
  );
}

/**
 * The full sent-offers page lists every active sent offer, so a yellow sent verdict or one only the page found is
 * gone when the page does not list it. A red verdict of the core stays until its `cleared` or the TTL: a page
 * Steam drew short must not take down the warning that matters most. A core that sends no `cleared` would never
 * take its red verdict back, so for that one the page does. Received and simulated verdicts stay: this page does
 * not list them.
 */
export function keepOnlyListed(offerIds: readonly string[]): Promise<void> {
  const listed = new Set(offerIds);
  const prunable = (x: OfferVerdict): boolean =>
    x.simulated === undefined &&
    x.direction === 'sent' &&
    (x.fromPage === true || x.level === 'UNLINKED_GIVE_ONLY' || x.clearable !== true);
  return update((v) => Object.fromEntries(Object.entries(v).filter(([id, x]) => listed.has(id) || !prunable(x))));
}

/** Debug console only: remove every simulated verdict. */
export function clearSimulatedVerdicts(): Promise<void> {
  return update((v) => Object.fromEntries(Object.entries(v).filter(([, x]) => !x.simulated)));
}
