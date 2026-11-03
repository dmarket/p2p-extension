import type { OfferVerdicts } from '@/state/offerGuard';
import { getVerdicts, subscribeVerdicts } from '@/state/verdicts';
import { useStoredValue } from '@/ui/hooks/useStoredValue';

/**
 * The cached suspicious-offer verdicts (src/background/offerGuard.ts), live. `undefined` until the first read
 * settles, so the popup can hold its home screen and paint it together with the row (App.tsx).
 */
export function useVerdicts(): OfferVerdicts | undefined {
  return useStoredValue<OfferVerdicts | undefined>(
    // A failed read shows no row rather than holding the home screen on the spinner.
    () => getVerdicts().catch(() => ({})),
    subscribeVerdicts,
    undefined,
  );
}
