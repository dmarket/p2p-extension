import { clearSteamCredential } from '@/background/credentialHygiene';
import { setBlockingReason, setLinkedSteamId } from '@/state/blocking';
import { setActiveTrackingCount } from '@/state/activeCount';

/**
 * Withdraw everything a stopped core was still asserting, and the Steam token it left in storage. Only the
 * deactivation path calls this (see the `stop` dep of the core lifecycle in entrypoints/background.ts).
 *
 * Each write is best effort and its rejection swallowed: the reconciler also calls this when the
 * activation flag could not be read, so all of them are likely to reject together, and a withdrawal that
 * fails is repeated by the next spawn's inactive pass.
 */
export function withdrawCoreState(): void {
  const bestEffort = (write: Promise<void>): void => {
    void write.catch(() => {});
  };
  bestEffort(setBlockingReason('NONE'));
  bestEffort(setLinkedSteamId(undefined));
  bestEffort(setActiveTrackingCount(0));
  bestEffort(clearSteamCredential());
}
