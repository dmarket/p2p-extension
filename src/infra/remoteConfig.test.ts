import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFetch } from '@/testing/stubs';

// The remote-config fetch/cache seam: one static JSON document on the CDN, revalidated with its ETag. The
// properties that matter: the last good document survives every kind of bad answer, an unchanged document
// costs a bodiless 304, and the request never carries the DMarket session cookies scoped over the CDN host.

// The env config is read at module scope in @/infra/config, so mutating import.meta.env after import
// changes nothing — the module itself is mocked instead (the same pattern consent.test.ts uses).
const URL_UNDER_TEST = 'https://cdn.test/p2p/extension-config.json';
vi.mock('@/infra/config', () => ({ remoteConfigConfig: { url: 'https://cdn.test/p2p/extension-config.json' } }));

const {
  fetchRemoteConfig,
  hasFetchedRemoteConfig,
  readCachedEntries,
  REMOTE_CONFIG_CACHE_KEY,
  REMOTE_CONFIG_FETCHED_AT_KEY,
  REMOTE_CONFIG_PARAM,
} = await import('@/infra/remoteConfig');

const ETAG_KEY = 'remoteconfig.etag';
const DOC = '{"tracker":{"cadence":{"fallbackHeartbeatIntervalMs":60000}}}';
const CACHED = { [REMOTE_CONFIG_PARAM]: '{"tracker":{}}' };
const HOUR = 60 * 60 * 1000;

/** A fresh Response per call: a body reads exactly once (see jsonResponse in @/testing/stubs). */
const reply = (body: string | null, status = 200, etag?: string) => () =>
  Promise.resolve(new Response(body, { status, headers: etag ? { ETag: etag } : {} }));

let fetchMock: ReturnType<typeof stubFetch>;
beforeEach(() => {
  fetchMock = stubFetch();
});

/** A live cache + its ETag + a stamp old enough that an unforced fetch is not throttled away. */
async function seedCache(etag = '"old"'): Promise<void> {
  await browser.storage.local.set({
    [REMOTE_CONFIG_CACHE_KEY]: CACHED,
    [REMOTE_CONFIG_FETCHED_AT_KEY]: Date.now() - 2 * HOUR,
    [ETAG_KEY]: etag,
  });
}

const readStamp = async (): Promise<unknown> =>
  (await browser.storage.local.get(REMOTE_CONFIG_FETCHED_AT_KEY))[REMOTE_CONFIG_FETCHED_AT_KEY];

describe('the request', () => {
  it('GETs the configured URL without cookies and outside the HTTP cache', async () => {
    fetchMock.mockImplementation(reply(DOC));
    await fetchRemoteConfig(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(URL_UNDER_TEST);
    expect(init?.method ?? 'GET').toBe('GET');
    // The CDN is under .dmarket.com, where the DMarket session cookies are scoped.
    expect(init?.credentials).toBe('omit');
    // Our ETag is the only cache layer, so a 304 reaches us as a 304.
    expect(init?.cache).toBe('no-store');
  });

  it('revalidates with the cached ETag, and sends none when there is no document to revalidate', async () => {
    fetchMock.mockImplementation(reply(null, 304));
    await seedCache('"v1"');
    await fetchRemoteConfig();
    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({ 'If-None-Match': '"v1"' });

    // An ETag without its body would get a 304 for a document we no longer hold.
    await browser.storage.local.remove(REMOTE_CONFIG_CACHE_KEY);
    await fetchRemoteConfig(true);
    expect(fetchMock.mock.calls[1]![1]?.headers).toEqual({});
  });
});

describe('the answers', () => {
  it('a 200 caches the document under p2p_tracker_config, with its ETag and a fresh stamp', async () => {
    fetchMock.mockImplementation(reply(DOC, 200, '"v2"'));
    const before = Date.now();

    await expect(fetchRemoteConfig(true)).resolves.toEqual({ [REMOTE_CONFIG_PARAM]: DOC });

    const stored = await browser.storage.local.get([
      REMOTE_CONFIG_CACHE_KEY,
      REMOTE_CONFIG_FETCHED_AT_KEY,
      ETAG_KEY,
    ]);
    expect(stored[REMOTE_CONFIG_CACHE_KEY]).toEqual({ [REMOTE_CONFIG_PARAM]: DOC });
    expect(stored[REMOTE_CONFIG_FETCHED_AT_KEY] as number).toBeGreaterThanOrEqual(before);
    expect(stored[ETAG_KEY]).toBe('"v2"');
  });

  it('a 304 keeps the cache and stamps the fetch', async () => {
    await seedCache();
    fetchMock.mockImplementation(reply(null, 304));
    const before = Date.now();

    await expect(fetchRemoteConfig()).resolves.toEqual(CACHED);

    const stored = await browser.storage.local.get([REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_FETCHED_AT_KEY]);
    expect(stored[REMOTE_CONFIG_CACHE_KEY]).toEqual(CACHED);
    expect(stored[REMOTE_CONFIG_FETCHED_AT_KEY] as number).toBeGreaterThanOrEqual(before);
  });

  it('a 200 without an ETag drops the old one, so the next fetch does not revalidate against it', async () => {
    await seedCache('"old"');
    fetchMock.mockImplementation(reply(DOC));
    await fetchRemoteConfig(true);
    expect((await browser.storage.local.get(ETAG_KEY))[ETAG_KEY]).toBeUndefined();
  });

  it.each([
    ['an HTML error page', '<html>not found</html>'],
    ['a truncated body', '{"tracker":'],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
  ])('%s served as 200 keeps the last good document and its stamp', async (_, body) => {
    await seedCache();
    const stampBefore = await readStamp();
    fetchMock.mockImplementation(reply(body));

    await expect(fetchRemoteConfig(true)).resolves.toEqual(CACHED);

    const stored = await browser.storage.local.get([REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_FETCHED_AT_KEY]);
    expect(stored[REMOTE_CONFIG_CACHE_KEY]).toEqual(CACHED);
    expect(stored[REMOTE_CONFIG_FETCHED_AT_KEY]).toBe(stampBefore);
  });

  it('a non-2xx keeps the document and its stamp, and falls back to the cache', async () => {
    await seedCache();
    const stampBefore = await readStamp();
    fetchMock.mockImplementation(reply('forbidden', 403));

    await expect(fetchRemoteConfig(true)).resolves.toEqual(CACHED);
    expect(await readStamp()).toBe(stampBefore);
  });

  it('a rejected fetch (network down, or CORS refused) falls back to the cache without throwing', async () => {
    await seedCache();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await expect(fetchRemoteConfig(true)).resolves.toEqual(CACHED);
    debug.mockRestore();
  });
});

describe('the throttle', () => {
  it('honours the default 1h interval and lets force bypass it', async () => {
    await browser.storage.local.set({
      [REMOTE_CONFIG_CACHE_KEY]: CACHED,
      [REMOTE_CONFIG_FETCHED_AT_KEY]: Date.now() - 10_000, // fresh
    });
    await expect(fetchRemoteConfig()).resolves.toEqual(CACHED);
    expect(fetchMock).not.toHaveBeenCalled(); // throttled: no network on a respawn-shaped call

    fetchMock.mockImplementation(reply(DOC));
    await fetchRemoteConfig(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // force = the debug console's refresh button
  });

  it('uses the interval the caller resolved from settings, not the default', async () => {
    await browser.storage.local.set({
      [REMOTE_CONFIG_CACHE_KEY]: CACHED,
      [REMOTE_CONFIG_FETCHED_AT_KEY]: Date.now() - 30 * 60 * 1000, // 30 min: fresh by the 1h default
    });
    fetchMock.mockImplementation(reply(DOC));

    await fetchRemoteConfig();
    expect(fetchMock).not.toHaveBeenCalled();

    await fetchRemoteConfig(false, 15 * 60 * 1000); // a published 15 min override
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the failure backoff', () => {
  // A failure writes no fetched_at, so without a backoff every worker spawn would retry: a CDN outage or a CORS
  // misconfiguration would become a request per install per minute.
  const FAILED_AT_KEY = 'remoteconfig.failed_at';

  it('holds off unforced fetches for 15 min after a failure, then retries', async () => {
    await seedCache();
    fetchMock.mockImplementation(reply('oops', 500));
    await fetchRemoteConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await fetchRemoteConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1); // backing off: no second request

    await browser.storage.local.set({ [FAILED_AT_KEY]: Date.now() - 16 * 60 * 1000 });
    await fetchRemoteConfig();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a non-2xx', reply('forbidden', 403)],
    ['a body that is not a JSON object', reply('<html>')],
    ['a rejected fetch', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('%s starts the backoff', async (_, impl) => {
    await seedCache();
    fetchMock.mockImplementation(impl);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await fetchRemoteConfig();
    debug.mockRestore();
    expect((await browser.storage.local.get(FAILED_AT_KEY))[FAILED_AT_KEY]).toEqual(expect.any(Number));
  });

  it('force bypasses it, and a good answer clears it', async () => {
    await seedCache();
    await browser.storage.local.set({ [FAILED_AT_KEY]: Date.now() });
    fetchMock.mockImplementation(reply(DOC));

    await fetchRemoteConfig(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await browser.storage.local.get(FAILED_AT_KEY))[FAILED_AT_KEY]).toBeUndefined();
  });

  it('a 304 clears it too', async () => {
    await seedCache();
    await browser.storage.local.set({ [FAILED_AT_KEY]: Date.now() });
    fetchMock.mockImplementation(reply(null, 304));
    await fetchRemoteConfig(true);
    expect((await browser.storage.local.get(FAILED_AT_KEY))[FAILED_AT_KEY]).toBeUndefined();
  });
});

describe('readCachedEntries', () => {
  it('answers {} for an absent or malformed cache and never throws', async () => {
    await expect(readCachedEntries()).resolves.toEqual({});
    await browser.storage.local.set({ [REMOTE_CONFIG_CACHE_KEY]: 'not an object' });
    await expect(readCachedEntries()).resolves.toEqual({});
  });
});

describe('hasFetchedRemoteConfig (the first-install signal)', () => {
  // The service worker boots the core ONCE with the overrides already resolved. On a first install there
  // is no document to resolve, so it briefly waits for this fetch instead of booting on defaults and
  // being restarted by the reply — a second full boot cycle plus a forced heartbeat, in the same window
  // as the install-time content-script re-injection. This predicate is what tells that spawn apart from
  // every other one, so getting it wrong either restores the double boot or makes EVERY spawn wait.
  it('is false on a fresh install, and true once any ok reply has landed', async () => {
    await expect(hasFetchedRemoteConfig()).resolves.toBe(false);
    fetchMock.mockImplementation(reply(DOC));
    await fetchRemoteConfig();
    await expect(hasFetchedRemoteConfig()).resolves.toBe(true);
  });

  it('stays false after a FAILED fetch, so the next spawn is still the first', async () => {
    fetchMock.mockImplementation(reply('oops', 500));
    await fetchRemoteConfig();
    await expect(hasFetchedRemoteConfig()).resolves.toBe(false);
  });

  it('is unaffected by a non-numeric stamp left by an older build', async () => {
    await browser.storage.local.set({ [REMOTE_CONFIG_FETCHED_AT_KEY]: 'yesterday' });
    await expect(hasFetchedRemoteConfig()).resolves.toBe(false);
  });
});
