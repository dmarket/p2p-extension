import { getActiveTrackingCount, subscribeActiveTrackingCount } from '@/state/activeCount';
import { useStoredValue } from '@/ui/hooks/useStoredValue';

/**
 * Preact hook exposing the tracker's live active-tracking count, kept in sync with browser.storage
 * across contexts (the background mirrors the core's count per cycle — see src/state/activeCount.ts).
 *
 * Returns `0` until the initial read resolves, then the live value. `0` is the natural empty state
 * (no trades being watched), so callers can render immediately without a separate loading branch.
 */
export function useActiveTrackingCount(): number {
  return useStoredValue<number>(getActiveTrackingCount, subscribeActiveTrackingCount, 0);
}
