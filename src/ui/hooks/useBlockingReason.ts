import { getBlockingReason, subscribeBlockingReason, type BlockingReason } from '@/state/blocking';
import { useStoredValue } from '@/ui/hooks/useStoredValue';

/**
 * Preact hook exposing the tracker's single blocking reason, kept in sync with browser.storage across
 * contexts (the background persists it per heartbeat — see src/state/blocking.ts).
 *
 * Returns `undefined` while the initial read is in flight, then the reason. Callers treat `undefined`
 * as "not blocked yet" to avoid flashing a blocking screen before the read resolves.
 */
export function useBlockingReason(): BlockingReason | undefined {
  return useStoredValue<BlockingReason | undefined>(getBlockingReason, subscribeBlockingReason, undefined);
}
