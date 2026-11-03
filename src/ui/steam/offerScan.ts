// Reads the offers on Steam's trade-offers page and tells whether a partner is a known scam account.
//
// Runs in the content script on `/tradeoffers/sent/`. It reads the page's own DOM and nothing else: whether an
// offer is linked to a DMarket deal is the core's call (src/state/offerGuard.ts), because only the core holds
// the deals. Whether a partner IMPERSONATES DMarket needs the persona name, which only this page shows, so
// that heuristic lives here. Selectors come from remote config (`web.offerSelectors`) so a Steam markup
// change is a publish, not a release.

import type { OfferSelectors } from '@/config/settings';
import { OFFER_ID, type OfferLevel } from '@/state/offerGuard';

export interface PageOffer {
  offerId: string;
  /** steamid64, from the partner's `data-miniprofile` account id. `undefined` when the page does not carry it. */
  partnerSteamId: string | undefined;
  personaName: string;
  giveCount: number;
  receiveCount: number;
}

const STEAM64_BASE = 76561197960265728n;
/** Steam's element id of an offer block is this prefix plus the offer id. */
export const OFFER_ID_PREFIX = 'tradeofferid_';

/** The steamid64 of a `data-miniprofile` account id. */
export function steamId64(accountId: string | undefined): string | undefined {
  if (accountId === undefined || !/^\d{1,10}$/.test(accountId)) return undefined;
  return (BigInt(accountId) + STEAM64_BASE).toString();
}

/** The `data-miniprofile` account id of a steamid64; `undefined` when it is not a number. */
export function accountId(steamId: string): string | undefined {
  try {
    return (BigInt(steamId) - STEAM64_BASE).toString();
  } catch {
    return undefined;
  }
}

/** The offer id of an offer block, from its `tradeofferid_<id>` element id only. */
export function blockOfferId(el: Element): string | undefined {
  if (!el.id.startsWith(OFFER_ID_PREFIX)) return undefined;
  const id = el.id.slice(OFFER_ID_PREFIX.length);
  return OFFER_ID.test(id) ? id : undefined;
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
    const offerId = blockOfferId(el);
    if (offerId === undefined) return [];
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
