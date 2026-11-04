// The words for one suspicious offer, shared by the Steam page banner and the popup row so the two cannot
// disagree about what an offer is or what the user should do with it.

import type { OfferDirection, OfferLevel } from '@/state/offerGuard';

export interface OfferCopyInput {
  level: OfferLevel;
  direction: OfferDirection;
  personaName?: string;
  partnerSteamId?: string;
  giveCount: number;
  /** A received impersonation flagged on the sender's name, not the known-scam list (`OfferVerdict.byName`). */
  byName?: boolean;
}

/** A run of plain text, or a value the banner sets apart. */
export type CopyPart = string | { value: string };

export interface OfferCopy {
  title: string;
  body: CopyPart[];
  /** "To {partner}" or "From {partner}". */
  partner: string;
  /** What to do, as one sentence. */
  advice: string;
}

/** DMarket's own bots send the user a give-only offer too, so a received offer is judged against this. */
const OUR_BOTS = 'DMarket bots only send you an offer for a deposit you started on dmarket.com';

function items(n: number): string {
  return `${n} ${n === 1 ? 'item' : 'items'}`;
}

export function offerCopy(o: OfferCopyInput): OfferCopy {
  // A received offer's sender may come without a name, so its steamid stands in.
  const label = o.personaName || o.partnerSteamId || 'this partner';
  if (o.direction === 'received') {
    const partner = `From ${label}`;
    const advice = "Decline it, don't accept or confirm it in Steam Mobile.";
    if (o.level === 'IMPERSONATION' && o.byName) {
      return {
        title: 'An account posing as a DMarket bot sent you a Steam offer',
        body: [{ value: label }, ` poses as a DMarket bot. ${OUR_BOTS} — decline it, don't accept or confirm it in Steam Mobile.`],
        partner,
        advice,
      };
    }
    return o.level === 'IMPERSONATION'
      ? {
          title: 'A known scam account sent you a Steam offer',
          body: [{ value: label }, ` is a known scam account. ${OUR_BOTS} — decline it, don't accept or confirm it in Steam Mobile.`],
          partner,
          advice,
        }
      : {
          title: "This trade offer isn't linked to a DMarket deal",
          body: [{ value: label }, ' asks for ', { value: items(o.giveCount) }, ` and gives nothing back. ${OUR_BOTS} — if you didn't start one, decline it.`],
          partner,
          advice,
        };
  }
  // A sent banner shows the steamid apart, so the name alone.
  const name = o.personaName || 'this partner';
  const partner = `To ${label}`;
  const advice = "Don't confirm it in Steam Mobile unless you created it yourself.";
  // Red copy is verbatim from DMA-819.
  const cabinet = 'Check the deal in your cabinet before confirming it in Steam Mobile.';
  return o.level === 'IMPERSONATION'
    ? {
        title: 'DMarket never asks you to send items to an account called "DMarket" or "D market"',
        body: [
          'The offer to "',
          { value: name },
          '"',
          ...(o.partnerSteamId !== undefined ? [' (', { value: o.partnerSteamId }, ')'] : []),
          ` looks like a scam. ${cabinet}`,
        ],
        partner,
        advice: cabinet,
      }
    : {
        title: "This trade offer isn't linked to a DMarket deal",
        body: [
          'You give ',
          { value: items(o.giveCount) },
          ' to ',
          { value: name },
          " and get nothing back. If you didn't create this offer yourself, don't confirm it in Steam Mobile.",
        ],
        partner,
        advice,
      };
}

/**
 * Whether "I know this partner" may dismiss the warning: only a yellow offer the user sent. A received one is
 * never dismissed this way: a scammer's offer looks like a deposit bot's, and trust would silence the next one.
 */
export function canTrust(o: Pick<OfferCopyInput, 'level' | 'direction' | 'partnerSteamId'>): boolean {
  return o.level === 'UNLINKED_GIVE_ONLY' && o.direction === 'sent' && o.partnerSteamId !== undefined;
}
