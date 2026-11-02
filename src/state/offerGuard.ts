// The suspicious-offer guard's shared vocabulary: what the service worker caches, and the messages the Steam
// content script exchanges with it. No runtime imports, so the content script, the popup, the worker and the
// debug console can all use it.
//
// The core decides which of this account's Steam offers, sent or received, are suspicious and reports them as the
// `SuspiciousOutgoingOffers` lifecycle event (core DMA-818, DMA-819). The worker keeps the latest level per offer in
// `storage.session` under GUARD_VERDICTS_KEY; the content script asks for the offers it sees on the page.

/** `UNLINKED_GIVE_ONLY`: gives items, gets none, no DMarket deal explains it. `IMPERSONATION`: the partner poses as DMarket. */
export type OfferLevel = 'UNLINKED_GIVE_ONLY' | 'IMPERSONATION';

export const OFFER_LEVELS: readonly OfferLevel[] = ['UNLINKED_GIVE_ONLY', 'IMPERSONATION'];

export function isOfferLevel(v: unknown): v is OfferLevel {
  return v === 'UNLINKED_GIVE_ONLY' || v === 'IMPERSONATION';
}

/** The higher of two levels; `undefined` is lowest. */
export function maxLevel(a: OfferLevel | undefined, b: OfferLevel | undefined): OfferLevel | undefined {
  return a === 'IMPERSONATION' || b === 'IMPERSONATION' ? 'IMPERSONATION' : (a ?? b);
}

/** Which of Steam's lists the offer is on: one this account sent, or one sent to it. */
export type OfferDirection = 'sent' | 'received';

export interface OfferVerdict {
  level: OfferLevel;
  /** For a received offer the partner is the sender, and the items given are this account's (core DMA-819). */
  direction: OfferDirection;
  partnerSteamId: string;
  giveCount: number;
  /** Epoch ms of the event that reported it. */
  at: number;
  /** The partner's Steam persona name, as the core read it from the Steam Web API. */
  personaName?: string;
  /** Debug simulation only: there is no such offer on Steam, the page draws a stand-in block for it. */
  simulated?: { personaName: string };
  /** The page recognised it and the core has not reported it: only a complete sent page can take it back. */
  fromPage?: true;
  /** Reported by a core that names the offers it stops flagging (`cleared`), so that, not the page, takes it back. */
  clearable?: true;
}

/** `storage.session`, so a browser restart forgets every verdict along with the offers it was about. */
export const GUARD_VERDICTS_KEY = 'guard.verdicts';

export type OfferVerdicts = Record<string, OfferVerdict>;

/** A steamid64 of an individual account. */
export const STEAM_ID64 = /^7656119\d{10}$/;

/** Steam's own offer ids: digits only. */
const OFFER_ID = /^\d{1,20}$/;

export function parseVerdicts(raw: unknown): OfferVerdicts {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: OfferVerdicts = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<OfferVerdict> | null;
    if (!OFFER_ID.test(id) || typeof r !== 'object' || r === null) continue;
    if (!isOfferLevel(r.level) || typeof r.partnerSteamId !== 'string') continue;
    out[id] = {
      level: r.level,
      // A cache written before received offers existed held sent ones only.
      direction: r.direction === 'received' ? 'received' : 'sent',
      partnerSteamId: r.partnerSteamId,
      giveCount: typeof r.giveCount === 'number' ? r.giveCount : 0,
      at: typeof r.at === 'number' ? r.at : 0,
      ...(typeof r.personaName === 'string' ? { personaName: r.personaName } : {}),
      ...(typeof r.simulated?.personaName === 'string' ? { simulated: { personaName: r.simulated.personaName } } : {}),
      ...(r.fromPage === true ? { fromPage: true as const } : {}),
      ...(r.clearable === true ? { clearable: true as const } : {}),
    };
  }
  return out;
}

/**
 * The core's own key in `storage.local`: epoch ms of its last sent-offers check, as a decimal string
 * (`PersistedOfferGuardStore`). Written before that check's verdicts are reported.
 */
export const GUARD_SCANNED_AT_KEY = 'tracker_guard_scanned_at';

/**
 * The core's own key in `storage.local`: the offers it has already reported, and at which level. It only reports
 * an offer again when the level changes, so this must go whenever the verdict cache does (src/background/sessionStart.ts).
 */
export const GUARD_NOTIFIED_KEY = 'tracker_guard_notified';

export function parseScanStamp(raw: unknown): number | null {
  const n = typeof raw === 'string' && /^\d{1,15}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

// ---- content script -> service worker -------------------------------------------------------------------

export const OFFER_VERDICTS_KIND = 'offer-verdicts';
export const TRUST_PARTNER_KIND = 'trust-partner';

export interface OfferVerdictsRequest {
  kind: typeof OFFER_VERDICTS_KIND;
  /** The offer ids on the page. */
  offerIds: string[];
  /**
   * The page lists every active sent offer (`/tradeoffers/sent/` without `history`), so a cached verdict for
   * an offer that is not on it is no longer active and can be forgotten.
   */
  pageComplete: boolean;
  /**
   * Offers on the page whose partner the page itself recognised as posing as DMarket (by name, or by the
   * known-account list), so the badge and the popup count them too. Can only add or raise to IMPERSONATION.
   */
  impersonations?: PageImpersonation[];
}

/** An offer on the sent list: no other page reports one, so nothing else would know to take it back. */
export interface PageImpersonation {
  offerId: string;
  partnerSteamId: string;
  giveCount: number;
}

export interface OfferVerdictsResponse {
  ok: true;
  verdicts: OfferVerdicts;
  /**
   * Epoch ms of the core's last check of this account's sent offers, once that check has finished reporting;
   * `null` when there is none or it is still reporting. The page shows "checking" until it moves past the
   * moment the page opened.
   */
  scannedAt: number | null;
  /** The core is running and not blocked, so a check will happen: without it the page shows no progress. */
  coreRunning: boolean;
  /** Debug builds only: simulated offers the page has no block for, so it can draw a stand-in. */
  simulated?: Record<string, OfferVerdict>;
}

export interface TrustPartnerRequest {
  kind: typeof TRUST_PARTNER_KIND;
  steamId: string;
}

export type GuardResponse = OfferVerdictsResponse | { ok: true } | { ok: false; error: string };

export function isOfferVerdictsRequest(m: unknown): m is OfferVerdictsRequest {
  const r = m as Partial<OfferVerdictsRequest> | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    r.kind === OFFER_VERDICTS_KIND &&
    Array.isArray(r.offerIds) &&
    r.offerIds.length <= 200 &&
    r.offerIds.every((id) => typeof id === 'string' && OFFER_ID.test(id)) &&
    typeof r.pageComplete === 'boolean' &&
    (r.impersonations === undefined ||
      (Array.isArray(r.impersonations) &&
        r.impersonations.every(
          (x) =>
            typeof x === 'object' &&
            x !== null &&
            r.offerIds!.includes(x.offerId) &&
            typeof x.partnerSteamId === 'string' &&
            STEAM_ID64.test(x.partnerSteamId) &&
            Number.isInteger(x.giveCount) &&
            x.giveCount >= 0 &&
            x.giveCount <= 1000,
        )))
  );
}

export function isTrustPartnerRequest(m: unknown): m is TrustPartnerRequest {
  const r = m as Partial<TrustPartnerRequest> | null;
  return typeof r === 'object' && r !== null && r.kind === TRUST_PARTNER_KIND && typeof r.steamId === 'string';
}

// ---- service worker -> content script ------------------------------------------------------------------

/** Sent to Steam trade-offers tabs when the cached verdicts change, so an open page asks again. */
export const GUARD_CHANGED_KIND = 'guard-verdicts-changed';

export function isGuardChangedPush(m: unknown): boolean {
  return typeof m === 'object' && m !== null && (m as { kind?: unknown }).kind === GUARD_CHANGED_KIND;
}
