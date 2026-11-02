// The published known-scam list (`web.knownScamPartners`) into the core (DMA-819). The core needs it to flag a
// received offer from one of those accounts; the Steam page's own check reads the same list from settings.

import { getSettings, subscribeSettings } from '@/config/settings';
import { Tracker, type TrackerHandle } from '@/core/tracker';

/**
 * Hand [ids] to the running core, an empty list included: publishing one is how a wrong entry is taken back. With
 * no published list nothing is sent, and the core keeps the one compiled into it.
 */
export function applyKnownScamPartners(handle: TrackerHandle, ids = getSettings().web.knownScamPartners): void {
  if (ids !== undefined) Tracker.setKnownScamPartners(handle, ids);
}

/** Re-send the list on every settings change to whichever core is running then. Returns an unsubscribe. */
export function forwardKnownScamPartners(getHandle: () => TrackerHandle | undefined): () => void {
  return subscribeSettings((s) => {
    const handle = getHandle();
    if (handle !== undefined) applyKnownScamPartners(handle, s.web.knownScamPartners);
  });
}
