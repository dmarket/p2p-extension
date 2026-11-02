// Keeps `storage.local` out of content scripts and gives them what they still need.
//
// The core keeps `steam_credential` (a live Steam web-API token) in `storage.local`, and a content script runs
// in the page's renderer process. So on Chrome the worker closes `storage.local` to untrusted contexts
// (Chrome 140+) and copies the four keys the Steam banner and the dmarket bridge read into `storage.session`,
// which it opens to them (Chrome 102+). `storage.local` stays the source of truth: every writer still writes
// there, and the one write a content script made (the banner's activation) now goes through
// {@link SET_ACTIVATION_KIND}. Firefox implements neither `setAccessLevel`, so there the mirror is skipped and
// content scripts keep reading `storage.local` (src/state/stateArea.ts).
//
// The activation flag is always mirrored as an explicit boolean, so a content script tells "the worker has not
// written the mirror yet" (key absent, right after a browser start) from "not activated" (false) and waits
// instead of rendering the onboarding banner to an activated seller. The other keys read an absent value and a
// null the same way.

import {
  ACTIVATION_KEY,
  SET_ACTIVATION_KIND,
  setActivated,
  type SetActivationMessage,
  type SetActivationResponse,
} from '@/state/activation';
import { BLOCKING_KEY, LINKED_STEAM_ID_KEY } from '@/state/blocking';
import { REMOTE_CONFIG_CACHE_KEY } from '@/infra/remoteConfig';
import { fromSteamTab } from '@/background/steamSender';
import { onStorageChanged } from '@/util/storageEvents';

export const MIRRORED_KEYS: readonly string[] = [ACTIVATION_KEY, BLOCKING_KEY, LINKED_STEAM_ID_KEY, REMOTE_CONFIG_CACHE_KEY];

let chain: Promise<void> = Promise.resolve();

/** Serialised, and each run re-reads `storage.local`, so a slow copy can never land after a newer one. */
function sync(keys: readonly string[]): Promise<void> {
  chain = chain
    .then(async () => {
      const stored = await browser.storage.local.get([...keys]);
      const value = (k: string): unknown => (k === ACTIVATION_KEY ? stored[k] === true : (stored[k] ?? null));
      await browser.storage.session.set(Object.fromEntries(keys.map((k) => [k, value(k)])));
    })
    .catch(() => {});
  return chain;
}

function isSetActivation(message: unknown): message is SetActivationMessage {
  const m = message as Partial<SetActivationMessage> | null;
  return typeof m === 'object' && m !== null && m.kind === SET_ACTIVATION_KIND && m.enabled === true;
}

/** `storage.local` accepts this only from Chrome 140; older versions throw or reject, and keep it open. */
function setAccessLevel(area: Browser.storage.StorageArea, accessLevel: `${Browser.storage.AccessLevel}`): void {
  try {
    void area.setAccessLevel({ accessLevel }).catch(() => {});
  } catch {
    /* unsupported in this browser version */
  }
}

/** Must be called synchronously on every worker spawn. Returns the first copy, for tests. */
export function registerStateMirror(): Promise<void> {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isSetActivation(message)) return undefined;
    if (!fromSteamTab(sender)) {
      sendResponse({ ok: false, error: 'sender not allowed' } satisfies SetActivationResponse);
      return undefined;
    }
    setActivated(true).then(
      () => sendResponse({ ok: true } satisfies SetActivationResponse),
      () => sendResponse({ ok: false, error: 'write failed' } satisfies SetActivationResponse),
    );
    return true;
  });

  if (import.meta.env.FIREFOX) return Promise.resolve();

  setAccessLevel(browser.storage.local, 'TRUSTED_CONTEXTS');
  setAccessLevel(browser.storage.session, 'TRUSTED_AND_UNTRUSTED_CONTEXTS');
  // Wakes the worker at browser start, so the mirror (cleared with the session) is rewritten before a restored
  // Steam tab waits on it for long.
  browser.runtime.onStartup.addListener(() => {});
  onStorageChanged((changes, area) => {
    if (area !== 'local') return;
    const changed = MIRRORED_KEYS.filter((k) => k in changes);
    if (changed.length > 0) void sync(changed);
  });
  return sync(MIRRORED_KEYS);
}
