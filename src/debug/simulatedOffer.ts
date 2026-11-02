// The `SuspiciousOutgoingOffers` frame the debug console's "simulate suspicious offer" injects (src/debug/router.ts):
// the frame the core emits, plus the one field only a simulation carries.

import type { SimulatedOffer } from '@/debug/protocol';
import { isOfferLevel, STEAM_ID64 } from '@/state/offerGuard';

/** `undefined` when [offer] is not one the core could have reported. */
export function simulatedOfferFrame(offer: SimulatedOffer): object | undefined {
  if (
    !/^\d{1,20}$/.test(offer.offerId) ||
    !STEAM_ID64.test(offer.partnerSteamId) ||
    !isOfferLevel(offer.level) ||
    (offer.direction !== 'sent' && offer.direction !== 'received')
  ) {
    return undefined;
  }
  const giveCount = Math.min(Math.max(Math.floor(offer.giveCount) || 1, 1), 50);
  return {
    event: 'SuspiciousOutgoingOffers',
    offers: [
      {
        offerId: offer.offerId,
        partnerSteamId: offer.partnerSteamId,
        level: offer.level,
        assetIdsGiven: Array.from({ length: giveCount }, (_, i) => String(i + 1)),
        personaName: offer.personaName,
        direction: offer.direction === 'received' ? 'RECEIVED' : 'SENT',
        simulatedPersonaName: offer.personaName,
      },
    ],
    cleared: [],
  };
}
