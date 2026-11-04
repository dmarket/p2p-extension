// Keeps both storage areas out of content scripts and gives them, by message, the few keys they still need.
//
// The core keeps `steam_credential` (a live Steam web-API token) in `storage.session` (older cores:
// `storage.local`), and a content script runs in the page's renderer process. So on Chrome the worker closes
// `storage.local` (Chrome 140+) and `storage.session` (Chrome 102+) to untrusted contexts, and content scripts
// ask it for the four keys the Steam banner and the dmarket bridge read (`state:get`); it pushes their
// changes to the tabs our content scripts run in (`state:changed`). Opening `storage.local` instead is
// not an option: access is read+write, and a content script able to write `remoteconfig.cache` could reconfigure
// the core. The one write a content script makes (the banner's activation) goes through
// {@link SET_ACTIVATION_KIND}. Firefox implements neither `setAccessLevel`, so there all of this is skipped and
// content scripts keep reading `storage.local` (src/state/stateArea.ts).
//
// The activation flag is always answered as an explicit boolean, so a content script tells "the worker has not
// answered" (key absent) from "not activated" (false) and waits instead of rendering the onboarding banner to an
// activated seller. The other keys read an absent value and a null the same way.

import {
  ACTIVATION_KEY,
  SET_ACTIVATION_KIND,
  setActivated,
  type SetActivationMessage,
  type SetActivationResponse,
} from '@/state/activation';
import { BLOCKING_KEY, LINKED_STEAM_ID_KEY } from '@/state/blocking';
import { isStateGet, STATE_CHANGED_KIND, type StateChangedMessage } from '@/state/stateArea';
import { REMOTE_CONFIG_CACHE_KEY } from '@/infra/remoteConfig';
import { broadcastToTabs } from '@/background/broadcast';
import { fromSteamTab } from '@/background/steamSender';
import { onStorageChanged } from '@/util/storageEvents';

export const MIRRORED_KEYS: readonly string[] = [ACTIVATION_KEY, BLOCKING_KEY, LINKED_STEAM_ID_KEY, REMOTE_CONFIG_CACHE_KEY];

/** The mirrored keys among `keys`, read from `storage.local` and normalised. Other keys are never answered. */
async function readMirrored(keys: readonly string[]): Promise<Record<string, unknown>> {
  const wanted = MIRRORED_KEYS.filter((k) => keys.includes(k));
  const stored = wanted.length > 0 ? await browser.storage.local.get(wanted) : {};
  return Object.fromEntries(wanted.map((k) => [k, normalise(k, stored[k])]));
}

function normalise(key: string, value: unknown): unknown {
  return key === ACTIVATION_KEY ? value === true : (value ?? null);
}

/** Every URL pattern our content scripts are declared for. */
function contentScriptPatterns(): string[] {
  try {
    return (browser.runtime.getManifest().content_scripts ?? []).flatMap((c) => c.matches ?? []);
  } catch {
    return [];
  }
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

/** Must be called synchronously on every worker spawn. Returns the clean-up of older builds' copy, for tests. */
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

  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isStateGet(message)) return undefined;
    // Content scripts of this extension, on any page they run on, and its own pages.
    if (sender.id !== browser.runtime.id) return undefined;
    readMirrored(message.keys).then(sendResponse, () => sendResponse({}));
    return true;
  });

  setAccessLevel(browser.storage.local, 'TRUSTED_CONTEXTS');
  // Older builds opened it; the core now keeps its Steam token here.
  setAccessLevel(browser.storage.session, 'TRUSTED_CONTEXTS');
  onStorageChanged((changes, area) => {
    if (area !== 'local') return;
    const changed = MIRRORED_KEYS.filter((k) => k in changes);
    if (changed.length === 0) return;
    const patterns = contentScriptPatterns();
    if (patterns.length === 0) return;
    const message: StateChangedMessage = {
      kind: STATE_CHANGED_KIND,
      changes: Object.fromEntries(changed.map((k) => [k, { newValue: normalise(k, changes[k]!.newValue) }])),
    };
    void broadcastToTabs(patterns, message);
  });
  // The copy older builds kept there for content scripts.
  return browser.storage.session.remove([...MIRRORED_KEYS]).catch(() => {});
}
