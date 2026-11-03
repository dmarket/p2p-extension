// The cached suspicious-offer verdicts (src/background/offerGuard.ts) as a read + subscribe pair, the way the other
// mirrors in this directory expose theirs. The vocabulary itself stays in ./offerGuard.ts, which has no runtime imports.

import { GUARD_VERDICTS_KEY, parseVerdicts, type OfferVerdicts } from '@/state/offerGuard';
import { subscribeKey } from '@/state/subscribeKey';

/** The verdicts as stored, without the worker's expiry filter. */
export async function getVerdicts(): Promise<OfferVerdicts> {
  const stored = await browser.storage.session.get(GUARD_VERDICTS_KEY);
  return parseVerdicts(stored[GUARD_VERDICTS_KEY]);
}

/** Subscribe to verdict changes. Returns an unsubscribe function. */
export function subscribeVerdicts(onChange: (verdicts: OfferVerdicts) => void): () => void {
  return subscribeKey('session', GUARD_VERDICTS_KEY, parseVerdicts, onChange);
}
