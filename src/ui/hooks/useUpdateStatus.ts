import { getUpdateStatus, subscribeUpdateStatus, type UpdateStatus } from '@/state/updateStatus';
import { useStoredValue } from '@/ui/hooks/useStoredValue';

/**
 * Preact hook exposing the forced-update status (src/state/updateStatus.ts), live across the stored state
 * and the settings. `undefined` until the first read resolves: the popup holds its home screen on the
 * loading state until then, so an install that needs an update never flashes its normal screen first.
 */
export function useUpdateStatus(): UpdateStatus<string> | undefined {
  return useStoredValue<UpdateStatus<string> | undefined>(getUpdateStatus, subscribeUpdateStatus, undefined);
}
