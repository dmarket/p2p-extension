// The activation flag: the single source of truth for whether the user has completed onboarding.
//
// It gates THE CORE ITSELF (src/background/coreLifecycle.ts) — not activated means no heartbeat, no
// presence and no Steam write — and it drives the popup screen (Inactive vs Active), the Steam on-page
// banner visibility, and the toolbar icon. The core gate is the load-bearing one, and the newest: this
// flag used to move nothing but pixels, so an installed-but-never-activated client tracked, delivered and
// proved exactly like an activated one while telling the page it was not tracking.
//
// Persisted in browser.storage.local so it survives service-worker respawns and is shared across the
// popup, content scripts and background — which subscribes, so a write from any context starts or stops
// the core.

import { subscribeKey } from '@/state/subscribeKey';

/** Exported so the dev storage inspector can address the row it offers Activate/Deactivate for, instead
 *  of re-typing the literal in a file that already imports {@link setActivated}. */
export const ACTIVATION_KEY = 'activation.enabled';

/** Read the current activation flag. Absent/unset counts as not activated. */
export async function isActivated(): Promise<boolean> {
  const stored = await browser.storage.local.get(ACTIVATION_KEY);
  return stored[ACTIVATION_KEY] === true;
}

/** Persist the activation flag. */
export async function setActivated(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [ACTIVATION_KEY]: enabled });
}

/**
 * Subscribe to activation changes across contexts (popup, content scripts, background).
 * Returns an unsubscribe function.
 */
export function subscribeActivation(onChange: (enabled: boolean) => void): () => void {
  return subscribeKey('local', ACTIVATION_KEY, (v) => v === true, onChange);
}
