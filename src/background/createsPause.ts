// Offer creation while a forced update is pending (DMA-482). The core pauses creating new Steam offers when told
// to (`setCreatesPaused`); this is where the host tells it. Cancels, trade events, proofs and tracking go on, and a
// deal whose offer this device already made still gets that offer back, so the trades in progress finish.
//
// `required`, not "the update screen shows": `checking` and `applying` stop creates too. It is derived from the
// minimum and the own version alone (the stored state does not enter into it), which keeps it synchronous, so the
// call can go in right after the core starts, before its first cycle can ask for a create.
//
// The pause lives in the core's memory, so it is sent again after every start (a respawn and a restart both begin
// unpaused), and on every settings change to whichever core is running then.

import { getSettings, subscribeSettings } from '@/config/settings';
import { Tracker, type TrackerHandle } from '@/core/tracker';
import { resolveUpdateStatus } from '@/state/updateStatus';
import { extensionVersion } from '@/util/extensionVersion';
import { numericVersion } from '@/util/version';

function isRequired(min: string | undefined): boolean {
  return resolveUpdateStatus({ min, own: numericVersion(extensionVersion()), stored: undefined }).required;
}

/** Send the current pause to [handle]: on while an update is required, off otherwise (a lifted rule resumes creates). */
export function applyCreatesPause(handle: TrackerHandle, min = getSettings().web.minExtensionVersion): void {
  Tracker.setCreatesPaused(handle, isRequired(min));
}

/** Re-send on every settings change to whichever core is running then. Returns an unsubscribe. */
export function forwardCreatesPause(getHandle: () => TrackerHandle | undefined): () => void {
  return subscribeSettings((s) => {
    const handle = getHandle();
    if (handle !== undefined) applyCreatesPause(handle, s.web.minExtensionVersion);
  });
}
