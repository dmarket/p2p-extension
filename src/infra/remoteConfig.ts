import { isRemoteConfigEnabled, remoteConfigConfig } from './config';

// Firebase Remote Config via its public REST endpoint — data-only JSON, no Firebase JS SDK and no
// remote code, so it is MV3-safe and works from the service worker.
//
// NOTE: to actually reach the endpoint from a packaged extension the host
// "https://firebaseremoteconfig.googleapis.com/*" must be in host_permissions. wxt.config.ts adds it
// automatically, and only when the Firebase env vars are set (so a build without Remote Config keeps
// minimal permissions). A failed fetch falls back to the cached entries (then to the caller's
// defaults, in src/config/settings.ts), so the extension keeps working either way.
//
// The fetched entries are consumed by the typed overlay in src/config/settings.ts, which parses the
// single JSON config document and merges it over the compiled-in / core defaults.

const ENDPOINT = 'https://firebaseremoteconfig.googleapis.com/v1';
const INSTANCE_ID_KEY = 'remoteconfig.instance_id';
const CACHE_KEY = 'remoteconfig.cache';
const FETCHED_AT_KEY = 'remoteconfig.fetched_at';

// The MV3 service worker respawns constantly (every event can spawn a fresh worker), and boot calls
// fetchRemoteConfig() each time. Firebase's own server-side minimum fetch interval is 12h; this
// client-side throttle stops us POSTing on every respawn while still refreshing often enough for a
// config change to land within the hour. `fetchRemoteConfig(true)` bypasses it — that is what the debug
// console's "refresh config" button calls to pick up a publish without waiting out the hour.
const MIN_FETCH_INTERVAL_MS = 60 * 60 * 1000; // 1h

/** The Remote Config entries map: parameter name → raw string value (JSON strings included). */
export type ConfigEntries = Record<string, string>;

/**
 * The ONE Remote Config parameter this client consumes: a single JSON document (a cross-client contract
 * — the iOS/Android clients read the same one). Parsed by the typed overlay in src/config/settings.ts.
 */
export const REMOTE_CONFIG_PARAM = 'p2p_tracker_config';

/**
 * Keep only the parameter above. The Firebase template may also carry parameters for other clients or
 * features; caching them would bloat storage, and every unrelated publish would change the cached value
 * and so fire a settings reload (storage.onChanged) for a config we don't read. A missing/non-string
 * value yields `{}` — i.e. "no config param", which the overlay resolves to the compiled defaults.
 */
function pickConsumed(entries: ConfigEntries): ConfigEntries {
  const value = entries[REMOTE_CONFIG_PARAM];
  return typeof value === 'string' ? { [REMOTE_CONFIG_PARAM]: value } : {};
}

/** The storage key the parsed-config overlay (src/config/settings.ts) reads + subscribes to. */
export { CACHE_KEY as REMOTE_CONFIG_CACHE_KEY };

/** Last-successful-fetch stamp — read by the debug console to tell a real fetch from a silent fallback. */
export { FETCHED_AT_KEY as REMOTE_CONFIG_FETCHED_AT_KEY };

async function getInstanceId(): Promise<string> {
  const stored = await browser.storage.local.get(INSTANCE_ID_KEY);
  const existing = stored[INSTANCE_ID_KEY];
  if (typeof existing === 'string' && existing) return existing;
  const id = crypto.randomUUID();
  await browser.storage.local.set({ [INSTANCE_ID_KEY]: id });
  return id;
}

/** Read the last cached Remote Config entries (or `{}` when absent/malformed). Never throws. */
export async function readCachedEntries(): Promise<ConfigEntries> {
  try {
    const stored = await browser.storage.local.get(CACHE_KEY);
    const cache = stored[CACHE_KEY];
    return cache && typeof cache === 'object' ? (cache as ConfigEntries) : {};
  } catch {
    return {};
  }
}

async function readFetchStamp(): Promise<number | undefined> {
  try {
    const stored = await browser.storage.local.get(FETCHED_AT_KEY);
    const at = stored[FETCHED_AT_KEY];
    return typeof at === 'number' ? at : undefined;
  } catch {
    return undefined;
  }
}

async function isCacheFresh(): Promise<boolean> {
  const at = await readFetchStamp();
  return at !== undefined && Date.now() - at < MIN_FETCH_INTERVAL_MS;
}

/**
 * Has a fetch ever completed on this install? (The stamp is written on every ok reply, including the
 * entry-less kind, and never on a failure — so this is "we have heard from the server at least once",
 * not "we have a cache".)
 *
 * The service worker uses it to tell a FIRST install from every other spawn: only the first has no
 * document to boot with, and only the first is therefore worth waiting for rather than booting the core
 * twice. See `bootCore` in src/entrypoints/background.ts.
 */
export async function hasFetchedRemoteConfig(): Promise<boolean> {
  return (await readFetchStamp()) !== undefined;
}

/**
 * Fetch the latest Remote Config entries, caching them for offline/failure fallback. Returns the
 * cached entries (or `{}`) when disabled, throttled, or on any error, so callers always get a usable
 * map. Throttled across service-worker respawns (see MIN_FETCH_INTERVAL_MS); pass `force` to bypass.
 */
export async function fetchRemoteConfig(force = false): Promise<ConfigEntries> {
  if (!isRemoteConfigEnabled()) return readCachedEntries();
  if (!force && (await isCacheFresh())) return readCachedEntries();
  const { apiKey, projectId, appId } = remoteConfigConfig;
  try {
    const url = `${ENDPOINT}/projects/${projectId}/namespaces/firebase:fetch?key=${apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_instance_id: await getInstanceId() }),
    });
    if (!response.ok) return readCachedEntries();
    const data = (await response.json()) as { entries?: ConfigEntries };
    // A 200 carrying no `entries` field at all (NO_CHANGE / NO_TEMPLATE style reply) says nothing about
    // the template's contents — KEEP the cache, or every such reply would wipe the live overrides.
    // Still stamp fetched_at so a healthy poll doesn't re-hit the network on every respawn. An explicit
    // `entries: {}` is a real (empty) template and IS written, hence the `undefined` check.
    if (data.entries === undefined) {
      await browser.storage.local.set({ [FETCHED_AT_KEY]: Date.now() });
      return readCachedEntries();
    }
    // Cache ONLY the parameter we consume (see pickConsumed). Writing the cache also fires
    // storage.onChanged → the settings snapshot refreshes.
    const entries = pickConsumed(data.entries);
    await browser.storage.local.set({ [CACHE_KEY]: entries, [FETCHED_AT_KEY]: Date.now() });
    return entries;
  } catch (error) {
    console.debug('[dmarket-p2p] remote config fetch failed', error);
    return readCachedEntries();
  }
}
