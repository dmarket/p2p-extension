// The activation flag: the single source of truth for whether the user has completed onboarding.
//
// It gates THE CORE ITSELF (src/background/coreLifecycle.ts) — not activated means no heartbeat, no
// presence and no Steam write — and it drives the popup screen (Inactive vs Active), the Steam on-page
// banner visibility, and the toolbar icon. The core gate is the load-bearing one, and the newest: this
// flag used to move nothing but pixels, so an installed-but-never-activated client tracked, delivered and
// proved exactly like an activated one while telling the page it was not tracking.
//
// Persisted in browser.storage.local so it survives service-worker respawns and is shared across the
// popup and background — which subscribes, so a write from any context starts or stops the core. Content
// scripts read the worker's copy in storage.session and ask the worker to write (src/background/stateMirror.ts).

import { STATE_AREA, stateStorage } from '@/state/stateArea';
import { subscribeKey } from '@/state/subscribeKey';

/** Exported so the dev storage inspector can address the row it offers Activate/Deactivate for, instead
 *  of re-typing the literal in a file that already imports {@link setActivated}. */
export const ACTIVATION_KEY = 'activation.enabled';

/**
 * Read the flag for a UI surface. `undefined` only in a content script whose mirror the worker has not written
 * yet (right after a browser start), so the banner waits instead of showing onboarding to an activated seller.
 */
export async function readActivation(): Promise<boolean | undefined> {
  const stored = await stateStorage().get(ACTIVATION_KEY);
  if (STATE_AREA === 'session' && stored[ACTIVATION_KEY] === undefined) return undefined;
  return stored[ACTIVATION_KEY] === true;
}

/** Read the current activation flag. Absent/unset counts as not activated. */
export async function isActivated(): Promise<boolean> {
  return (await readActivation()) === true;
}

/** Persist the activation flag. Trusted contexts only; a content script uses {@link requestActivation}. */
export async function setActivated(enabled: boolean): Promise<void> {
  await browser.storage.local.set({ [ACTIVATION_KEY]: enabled });
}

/**
 * Subscribe to activation changes across contexts (popup, content scripts, background).
 * Returns an unsubscribe function.
 */
export function subscribeActivation(onChange: (enabled: boolean) => void): () => void {
  return subscribeKey(STATE_AREA, ACTIVATION_KEY, (v) => v === true, onChange);
}

export const SET_ACTIVATION_KIND = 'set-activation';

/** Sent by the Steam banner, which may not write `storage.local`. The worker accepts only `enabled: true`. */
export interface SetActivationMessage {
  kind: typeof SET_ACTIVATION_KIND;
  enabled: true;
}

export type SetActivationResponse = { ok: true } | { ok: false; error: string };

/** Activate from a content script: the worker checks the sender and writes the flag. Throws on refusal. */
export async function requestActivation(): Promise<void> {
  const reply = await browser.runtime.sendMessage<SetActivationMessage, SetActivationResponse | undefined>({
    kind: SET_ACTIVATION_KIND,
    enabled: true,
  });
  if (!reply?.ok) throw new Error(`activation refused: ${reply?.error ?? 'no answer'}`);
}
