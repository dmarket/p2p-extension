import { getLinkedSteamId, subscribeLinkedSteamId } from '@/state/blocking';
import { useStoredValue } from '@/ui/hooks/useStoredValue';

/**
 * Preact hook exposing the DMarket-linked Steam id reported with the current wrong-account block, kept in
 * sync with browser.storage across contexts (see src/state/blocking.ts).
 *
 * Returns `undefined` both while the initial read is in flight and when no id is known — the surfaces that
 * use it fall back to generic copy either way, so the two cases need no distinction.
 */
export function useLinkedSteamId(): string | undefined {
  return useStoredValue<string | undefined>(getLinkedSteamId, subscribeLinkedSteamId, undefined);
}
