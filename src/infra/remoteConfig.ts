import { remoteConfigConfig } from './config';

// Remote config: one static JSON document on our CDN (buckets/<env>/p2p/extension-config.json, published with
// buckets/upload.sh). Data only, no remote code, so it is MV3-safe and works from the service worker.
//
// REACHABILITY. The CDN host is NOT in host_permissions — adding a host in an update is a privilege increase —
// so this fetch goes through CORS, and the bucket must allow the extension's origin
// (`chrome-extension://<id>`) for GET plus the `If-None-Match` preflight, and expose `ETag`. Debug builds add
// the dev CDN host to host_permissions (wxt.config.ts), so they work without that. A failed fetch falls back
// to the cached document, then to the compiled defaults (src/config/settings.ts), so the extension keeps
// working either way.
//
// The document is consumed by the typed overlay in src/config/settings.ts. It is cached under the same entries
// shape the Firebase-era fetch used (`{ p2p_tracker_config: <json string> }`), so an install updating from that
// era keeps its cache until the first fetch here replaces it.

const CACHE_KEY = 'remoteconfig.cache';
const FETCHED_AT_KEY = 'remoteconfig.fetched_at';
const ETAG_KEY = 'remoteconfig.etag';
const FAILED_AT_KEY = 'remoteconfig.failed_at';

/**
 * How long a failed fetch holds off the next unforced one. A failure writes no `fetched_at`, so without this
 * every worker spawn (about once a minute while deals are tracked) would retry: a CDN outage or a CORS
 * misconfiguration would turn into a request per install per minute instead of per interval. 15 min is the
 * floor of `web.remoteConfigFetchIntervalMs`, so a failure never delays the next attempt past a healthy one.
 */
const FAILURE_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Default client-side refetch interval; remote-overridable as `web.remoteConfigFetchIntervalMs`. The MV3 service
 * worker respawns constantly and boot calls fetchRemoteConfig() on each spawn — this is what stops that from
 * hitting the CDN every time. An unchanged document costs a `304` with no body. A shorter published interval
 * only takes effect after each install's next scheduled fetch, since the interval itself arrives by a fetch.
 * `fetchRemoteConfig(true)` bypasses it — that is what the debug console's "refresh config" button calls.
 */
export const REMOTE_CONFIG_FETCH_INTERVAL_MS = 60 * 60 * 1000;

/** The cached entries map: parameter name → raw string value (JSON strings included). */
export type ConfigEntries = Record<string, string>;

/** The key the document is cached under. Parsed by the typed overlay in src/config/settings.ts. */
export const REMOTE_CONFIG_PARAM = 'p2p_tracker_config';

/** The storage key the parsed-config overlay (src/config/settings.ts) reads + subscribes to. */
export { CACHE_KEY as REMOTE_CONFIG_CACHE_KEY };

/** Last-successful-fetch stamp — read by the debug console to tell a real fetch from a silent fallback. */
export { FETCHED_AT_KEY as REMOTE_CONFIG_FETCHED_AT_KEY };

/** Read the last cached entries (or `{}` when absent/malformed). Never throws. */
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

async function isCacheFresh(minIntervalMs: number): Promise<boolean> {
  const at = await readFetchStamp();
  return at !== undefined && Date.now() - at < minIntervalMs;
}

async function isBackingOff(): Promise<boolean> {
  try {
    const at = (await browser.storage.local.get(FAILED_AT_KEY))[FAILED_AT_KEY];
    return typeof at === 'number' && Date.now() - at < FAILURE_BACKOFF_MS;
  } catch {
    return false;
  }
}

/** Record a failed attempt and fall back to the cache. */
async function failed(): Promise<ConfigEntries> {
  try {
    await browser.storage.local.set({ [FAILED_AT_KEY]: Date.now() });
  } catch {
    /* the fallback below still applies */
  }
  return readCachedEntries();
}

/**
 * The validator to send, or `undefined` when there is no document to revalidate. Tied to the cache: an ETag
 * without the body it describes would get a `304` for a document we no longer hold.
 */
async function readEtag(): Promise<string | undefined> {
  try {
    const stored = await browser.storage.local.get([ETAG_KEY, CACHE_KEY]);
    const etag = stored[ETAG_KEY];
    const cache = stored[CACHE_KEY] as ConfigEntries | undefined;
    return typeof etag === 'string' && etag && typeof cache?.[REMOTE_CONFIG_PARAM] === 'string' ? etag : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON object, i.e. a document the overlay can read. An error page served as 200 is not one. */
function isJsonObject(text: string): boolean {
  try {
    const doc: unknown = JSON.parse(text);
    return typeof doc === 'object' && doc !== null && !Array.isArray(doc);
  } catch {
    return false;
  }
}

/**
 * Has a fetch ever completed on this install? (The stamp is written on every ok reply, `304` included, and
 * never on a failure — so this is "we have heard from the server at least once", not "we have a cache".)
 *
 * The service worker uses it to tell a FIRST install from every other spawn: only the first has no
 * document to boot with, and only the first is therefore worth waiting for rather than booting the core
 * twice. See `bootCore` in src/entrypoints/background.ts.
 */
export async function hasFetchedRemoteConfig(): Promise<boolean> {
  return (await readFetchStamp()) !== undefined;
}

/**
 * Fetch the latest document, caching it for offline/failure fallback. Returns the cached entries (or `{}`) when
 * throttled, backing off after a failure, or on any error, so callers always get a usable map.
 *
 * @param minIntervalMs the resolved `web.remoteConfigFetchIntervalMs`. A parameter rather than a read of the
 *   settings snapshot because src/config/settings.ts imports this module — reading it back would be a cycle.
 * @param onFetched called with the document in effect once the server has answered — a `200` carrying a
 *   readable document, or a `304` — and not when throttled or on a failure. That is the cadence of "we asked",
 *   which the forced-update retry keys on (src/background/forceUpdate.ts).
 */
export async function fetchRemoteConfig(
  force = false,
  minIntervalMs = REMOTE_CONFIG_FETCH_INTERVAL_MS,
  onFetched?: (entries: ConfigEntries) => void,
): Promise<ConfigEntries> {
  if (!force && ((await isCacheFresh(minIntervalMs)) || (await isBackingOff()))) return readCachedEntries();
  try {
    const etag = await readEtag();
    const response = await fetch(remoteConfigConfig.url, {
      headers: etag ? { 'If-None-Match': etag } : {},
      // Our own ETag is the only cache layer: with the HTTP cache in play, a `304` could come back to us as the
      // browser's cached `200`, and a stale CDN copy could be served without asking at all.
      cache: 'no-store',
      // The CDN sits under `.dmarket.com`, which is where the DMarket session cookies are scoped. Nothing about
      // a public config file needs them, so they must not ride along.
      credentials: 'omit',
    });
    if (response.status === 304) {
      await browser.storage.local.set({ [FETCHED_AT_KEY]: Date.now() });
      await browser.storage.local.remove(FAILED_AT_KEY);
      const cached = await readCachedEntries();
      onFetched?.(cached);
      return cached;
    }
    if (!response.ok) return failed();
    const text = await response.text();
    // Keep the last good document over anything unreadable: a truncated body or an HTML error page must not
    // drop every live override until the next good fetch.
    if (!isJsonObject(text)) return failed();
    const entries: ConfigEntries = { [REMOTE_CONFIG_PARAM]: text };
    const nextEtag = response.headers.get('ETag');
    // Writing the cache fires storage.onChanged → the settings snapshot refreshes.
    await browser.storage.local.set({ [CACHE_KEY]: entries, [FETCHED_AT_KEY]: Date.now() });
    if (nextEtag) await browser.storage.local.set({ [ETAG_KEY]: nextEtag });
    else await browser.storage.local.remove(ETAG_KEY);
    await browser.storage.local.remove(FAILED_AT_KEY);
    onFetched?.(entries);
    return entries;
  } catch (error) {
    console.debug('[dmarket-p2p] remote config fetch failed', error);
    return failed();
  }
}
