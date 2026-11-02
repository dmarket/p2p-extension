// Reads the offers on Steam's trade-offers page and tells whether a partner is a known scam account.
//
// Runs in the content script on `/tradeoffers/sent/`. It reads the page's own DOM and nothing else: whether an
// offer is linked to a DMarket deal is the core's call (src/state/offerGuard.ts), because only the core holds
// the deals. Whether a partner IMPERSONATES DMarket needs the persona name, which only this page shows, so
// that heuristic lives here. Selectors come from remote config (`web.offerSelectors`) so a Steam markup
// change is a publish, not a release.

import type { OfferSelectors } from '@/config/settings';
import type { OfferLevel } from '@/state/offerGuard';

export interface PageOffer {
  offerId: string;
  /** steamid64, from the partner's `data-miniprofile` account id. `undefined` when the page does not carry it. */
  partnerSteamId: string | undefined;
  personaName: string;
  giveCount: number;
  receiveCount: number;
}

const STEAM64_BASE = 76561197960265728n;
const OFFER_ID_PREFIX = 'tradeofferid_';

function steamId64(accountId: string | undefined): string | undefined {
  if (accountId === undefined || !/^\d{1,10}$/.test(accountId)) return undefined;
  return (BigInt(accountId) + STEAM64_BASE).toString();
}

/**
 * The partner's name from the offer header ("You offered NAME a trade:"). Steam localises the sentence, so the
 * name's own element is tried first and the English sentence only as a fallback.
 */
function personaName(header: Element | null): string {
  if (header === null) return '';
  const named = Array.from(header.children).find((c) => (c.textContent ?? '').trim() !== '');
  if (named !== undefined) return (named.textContent ?? '').trim();
  return header.textContent?.match(/offered\s+(.+?)\s+a trade/i)?.[1]?.trim() ?? '';
}

export function scanSentOffers(root: ParentNode, s: OfferSelectors): PageOffer[] {
  return Array.from(root.querySelectorAll<HTMLElement>(s.offer)).flatMap((el) => {
    if (!el.id.startsWith(OFFER_ID_PREFIX)) return [];
    const offerId = el.id.slice(OFFER_ID_PREFIX.length);
    if (!/^\d+$/.test(offerId)) return [];
    const partner = el.querySelector<HTMLElement>(s.partner);
    return [
      {
        offerId,
        partnerSteamId: steamId64(partner?.dataset.miniprofile),
        personaName: personaName(el.querySelector(s.header)),
        giveCount: el.querySelectorAll(s.given).length,
        receiveCount: el.querySelectorAll(s.received).length,
      },
    ];
  });
}

// ---- Impersonation ------------------------------------------------------------------------------------

/**
 * Whether [offer]'s partner is an account known to pose as DMarket. The name check lives in the core, which
 * reads persona names from the Steam Web API: the name on this page is a localised sentence.
 */
export function isKnownScamPartner(offer: Pick<PageOffer, 'partnerSteamId'>, knownScamPartners: readonly string[]): boolean {
  return offer.partnerSteamId !== undefined && knownScamPartners.includes(offer.partnerSteamId);
}

/** The level the page shows for [offer]: the core's verdict, raised to IMPERSONATION for a known scam account. */
export function pageLevel(
  offer: PageOffer,
  coreLevel: OfferLevel | undefined,
  knownScamPartners: readonly string[],
): OfferLevel | undefined {
  return isKnownScamPartner(offer, knownScamPartners) ? 'IMPERSONATION' : coreLevel;
}
