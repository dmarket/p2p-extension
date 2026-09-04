import { isActivated, subscribeActivation } from '@/state/activation';
import { useStoredValue } from '@/ui/hooks/useStoredValue';

/**
 * Preact hook exposing the activation flag, kept in sync with browser.storage across contexts.
 *
 * Returns `undefined` while the initial read is in flight, then the boolean value. Callers render a
 * neutral/loading state for `undefined` to avoid flashing the wrong screen.
 */
export function useActivation(): boolean | undefined {
  return useStoredValue<boolean | undefined>(isActivated, subscribeActivation, undefined);
}
