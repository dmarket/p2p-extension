// The pages whose warnings come from the core's verdicts alone, with no reading of the offers' markup:
//  - the single-offer page, `steamcommunity.com/tradeoffer/<id>/`: where a scammer's direct link lands, so the user
//    may confirm the offer in Steam Mobile without ever opening the sent list. The offer comes from the URL; this
//    page's markup is Steam's trade window, not the list the sent-page scan reads (src/ui/steam/offerScan.ts);
//  - the trade-offers landing page, `/tradeoffers/`, which lists the offers sent TO the user. The sent-page scan
//    would read the user there as the partner, so only the block ids are taken.

import type { OfferSelectors } from '@/config/settings';
import { OFFER_VERDICTS_KIND, type OfferVerdict, type OfferVerdicts, type OfferVerdictsRequest } from '@/state/offerGuard';
import { blockOfferId, isKnownScamPartner, pageLevel } from './offerScan';
import type { OfferWarning } from './useOfferWarnings';

const OFFER_PAGE = /^\/tradeoffer\/(\d{1,20})(?:\/|$)/;

/** The offer id of a `/tradeoffer/<id>/` path; `undefined` elsewhere, `/tradeoffer/new/` included. */
export function offerPageId(pathname: string): string | undefined {
  return OFFER_PAGE.exec(pathname)?.[1];
}

/**
 * What the offer page and the landing page ask the worker: the verdicts of [offerIds] only, never as a complete
 * page (that would make the worker drop every other cached verdict), and with no impersonations of their own.
 */
export function verdictsRequest(offerIds: string[]): OfferVerdictsRequest {
  return { kind: OFFER_VERDICTS_KIND, offerIds, pageComplete: false };
}

/** The banner for this page's offer, from its verdict: the name and item count are the core's. */
export function offerPageWarning(
  offerId: string,
  verdict: OfferVerdict | undefined,
  knownScamPartners: readonly string[],
): OfferWarning | undefined {
  if (verdict === undefined) return undefined;
  const offer = {
    offerId,
    partnerSteamId: verdict.partnerSteamId,
    personaName: verdict.personaName ?? verdict.simulated?.personaName ?? '',
    giveCount: verdict.giveCount,
    receiveCount: 0,
  };
  const level = pageLevel(offer, verdict.level, knownScamPartners);
  return level === undefined
    ? undefined
    : {
        offer,
        level,
        direction: verdict.direction,
        // The list may have gained the sender since the worker decided.
        ...(verdict.byName && !isKnownScamPartner(offer, knownScamPartners) ? { byName: true as const } : {}),
      };
}

const LANDING_PAGE = /\/tradeoffers\/?$/;

/** The landing page with its current offers: not `/sent/`, not `?history`. */
export function isLandingPage(pathname: string, search: string): boolean {
  return LANDING_PAGE.test(pathname) && !new URLSearchParams(search).has('history');
}

/** The ids of the offer blocks on the page, from their `tradeofferid_<id>` element ids only. */
export function offerBlockIds(root: ParentNode, s: Pick<OfferSelectors, 'offer'>): string[] {
  return Array.from(root.querySelectorAll<HTMLElement>(s.offer)).flatMap((el) => {
    const id = blockOfferId(el);
    return id === undefined ? [] : [id];
  });
}

/** The landing page's banners: the received verdicts among its offers. A sent offer is the sent page's to show. */
export function landingWarnings(
  offerIds: readonly string[],
  verdicts: OfferVerdicts,
  knownScamPartners: readonly string[],
): OfferWarning[] {
  return offerIds.flatMap((id) => {
    const v = verdicts[id];
    const w = v?.direction === 'received' ? offerPageWarning(id, v, knownScamPartners) : undefined;
    return w === undefined ? [] : [w];
  });
}

/** A check this recent counts as fresh: the core runs a page-requested check at most this often (DMA-818). */
export const CHECK_FRESH_MS = 30_000;

/** The "checking" notice goes after this long whatever happens, so it cannot hang over the page. */
export const CHECK_TIMEOUT_MS = 15_000;

/**
 * Whether the page shows "checking": the core is running, its last check is older than the moment the page
 * opened (and not one of the last CHECK_FRESH_MS, which the core would not repeat), and CHECK_TIMEOUT_MS has not
 * passed. No "checked, looks fine" state follows: the check knows a few patterns, and a green mark on a
 * scammer's offer would read as DMarket's approval.
 */
export function checkingVisible(input: {
  coreRunning: boolean;
  scannedAt: number | null;
  openedAt: number;
  now: number;
}): boolean {
  const { coreRunning, scannedAt, openedAt, now } = input;
  if (!coreRunning || now - openedAt >= CHECK_TIMEOUT_MS) return false;
  if (scannedAt === null) return true;
  return openedAt - scannedAt >= CHECK_FRESH_MS;
}
