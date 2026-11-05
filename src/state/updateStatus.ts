// Forced-update status, readable from every extension page: the service worker answers `pong.update` with it
// (src/background/forceUpdate.ts) and the popup shows the "Update required" screen from it.
//
// One resolver for both, so the popup can never disagree with what the page is told. It deliberately does
// not import src/background/update.ts: the worker's in-memory `applying` flag is layered on top by the
// worker itself, and the popup bundle must not pull the reload machinery in.

import { loadSettings, subscribeSettings } from '@/config/settings';
import { subscribeKey } from '@/state/subscribeKey';
import { extensionVersion } from '@/util/extensionVersion';
import { compareVersions, numericVersion } from '@/util/version';

export type UpdateState = 'none' | 'checking' | 'applying' | 'restart_required';

/**
 * `pong.update`. `minVersion` is absent only before the first config document arrives. `S` widens `state`
 * for readers that must keep a value written by a newer build (the popup); the worker keeps it narrow.
 */
export interface UpdateStatus<S extends string = UpdateState> {
  required: boolean;
  minVersion?: string;
  state: UpdateState | S;
}

/** `storage.session` key; written only by the service worker. */
export const UPDATE_STATE_KEY = 'update.forced';

/** What the worker stored: the minimum the state was reached for, and the state. */
export interface StoredUpdateState<S extends string = string> {
  min: string;
  state: S;
}

/** Any well-formed record; `state` is kept as written, so a state this build does not know survives. */
export function parseStoredUpdateState(value: unknown): StoredUpdateState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { min, state } = value as Partial<StoredUpdateState>;
  return typeof min === 'string' && typeof state === 'string' && state !== '' ? { min, state } : undefined;
}

/** The status for a minimum, an own (numeric) version and the stored record, if any. Pure. */
export function resolveUpdateStatus<S extends string>(input: {
  min: string | undefined;
  own: string;
  stored: StoredUpdateState<S> | undefined;
}): UpdateStatus<S> {
  const { min, own, stored } = input;
  if (min === undefined || compareVersions(own, min) >= 0) {
    return { required: false, ...(min !== undefined ? { minVersion: min } : {}), state: 'none' };
  }
  // No state yet for this minimum: the worker evaluates on every spawn, so `checking` is the truthful answer.
  return { required: true, minVersion: min, state: stored?.min === min ? stored.state : 'checking' };
}

/**
 * Whether the user has to act: an update is required and the extension is not already on it. `checking` and
 * `applying` resolve themselves within seconds; `restart_required`, and any state a newer build wrote, do not.
 */
export function needsUpdateScreen(status: UpdateStatus<string>): boolean {
  return status.required && status.state !== 'checking' && status.state !== 'applying';
}

/**
 * The status as an extension page sees it. Loads the settings first, so a cold popup reads the real minimum.
 * Never rejects: a read that fails reads as no update, so the popup cannot stay on its loading state.
 */
export async function getUpdateStatus(): Promise<UpdateStatus<string>> {
  try {
    const min = (await loadSettings()).web.minExtensionVersion;
    const stored = parseStoredUpdateState((await browser.storage.session.get(UPDATE_STATE_KEY))[UPDATE_STATE_KEY]);
    return resolveUpdateStatus({ min, own: numericVersion(extensionVersion()), stored });
  } catch {
    return { required: false, state: 'none' };
  }
}

/** Re-resolve whenever the stored state or the settings (the minimum) change. Returns an unsubscribe. */
export function subscribeUpdateStatus(onChange: (status: UpdateStatus<string>) => void): () => void {
  const refresh = () => void getUpdateStatus().then(onChange);
  const offState = subscribeKey('session', UPDATE_STATE_KEY, () => undefined, refresh);
  const offSettings = subscribeSettings(refresh);
  return () => {
    offState();
    offSettings();
  };
}
