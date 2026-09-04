import { beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, stubFetch } from '@/testing/stubs';

// The Remote Config fetch/cache seam. The property that matters most is the entry-less-200 guard: a 200
// carrying no `entries` field (a NO_CHANGE / NO_TEMPLATE-style reply) used to be written as
// `data.entries ?? {}`, which WIPED the cache — dropping every live override until the next good fetch.
// Easy to hit repeatedly once the debug console grew a force button.

// The env config is read at module scope in @/infra/config, so mutating import.meta.env after import
// changes nothing — the module itself is mocked instead (the same pattern consent.test.ts uses).
vi.mock('@/infra/config', () => ({
  isRemoteConfigEnabled: () => true,
  remoteConfigConfig: { apiKey: 'test-key', projectId: 'test-project', appId: 'test-app' },
}));

const {
  fetchRemoteConfig,
  hasFetchedRemoteConfig,
  readCachedEntries,
  REMOTE_CONFIG_CACHE_KEY,
  REMOTE_CONFIG_FETCHED_AT_KEY,
  REMOTE_CONFIG_PARAM,
} = await import('@/infra/remoteConfig');

const CACHED = { [REMOTE_CONFIG_PARAM]: '{"tracker":{}}' };

let fetchMock: ReturnType<typeof stubFetch>;
beforeEach(() => {
  fetchMock = stubFetch();
});

/** Seed a live cache + a stale-enough stamp so an unforced fetch is not throttled away. */
async function seedCache(): Promise<void> {
  await browser.storage.local.set({
    [REMOTE_CONFIG_CACHE_KEY]: CACHED,
    [REMOTE_CONFIG_FETCHED_AT_KEY]: Date.now() - 2 * 60 * 60 * 1000,
  });
}

describe('the entry-less-200 guard', () => {
  it('a 200 with NO entries field keeps the cache and stamps fetched_at', async () => {
    await seedCache();
    fetchMock.mockResolvedValue(jsonResponse({ state: 'NO_CHANGE' }));
    const before = Date.now();

    const entries = await fetchRemoteConfig(true);

    expect(entries).toEqual(CACHED);
    const stored = await browser.storage.local.get([REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_FETCHED_AT_KEY]);
    expect(stored[REMOTE_CONFIG_CACHE_KEY]).toEqual(CACHED); // NOT wiped
    expect(stored[REMOTE_CONFIG_FETCHED_AT_KEY] as number).toBeGreaterThanOrEqual(before); // but stamped
  });

  it('an EXPLICIT empty entries object is a real (empty) template and IS written', async () => {
    // The check is on `undefined`, not falsiness — an operator who really emptied the template must see
    // the overrides drop.
    await seedCache();
    fetchMock.mockResolvedValue(jsonResponse({ entries: {} }));
    await expect(fetchRemoteConfig(true)).resolves.toEqual({});
    const stored = await browser.storage.local.get(REMOTE_CONFIG_CACHE_KEY);
    expect(stored[REMOTE_CONFIG_CACHE_KEY]).toEqual({});
  });
});

describe('pickConsumed — only our parameter is cached', () => {
  it('filters a mixed template down to p2p_tracker_config', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        entries: {
          [REMOTE_CONFIG_PARAM]: '{"tracker":{"http":{"requestTimeoutMs":45000}}}',
          other_feature_flag: 'true',
          ios_something: '{"x":1}',
        },
      }),
    );
    const entries = await fetchRemoteConfig(true);
    expect(Object.keys(entries)).toEqual([REMOTE_CONFIG_PARAM]);
  });

  it('an unrelated-parameter publish leaves the cached value byte-identical (no settings reload)', async () => {
    // The cache write is what fires storage.onChanged → subscribeSettings; caching foreign params would
    // make every unrelated publish restart-adjacent work.
    await seedCache();
    fetchMock.mockResolvedValue(
      jsonResponse({ entries: { ...CACHED, some_new_unrelated_param: 'v2' } }),
    );
    await fetchRemoteConfig(true);
    const stored = await browser.storage.local.get(REMOTE_CONFIG_CACHE_KEY);
    expect(stored[REMOTE_CONFIG_CACHE_KEY]).toEqual(CACHED);
  });

  it('a template without our parameter, or with a non-string value, caches {} (→ compiled defaults)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: { other: 'x' } }));
    await expect(fetchRemoteConfig(true)).resolves.toEqual({});
    fetchMock.mockResolvedValue(jsonResponse({ entries: { [REMOTE_CONFIG_PARAM]: 42 } }));
    await expect(fetchRemoteConfig(true)).resolves.toEqual({});
  });
});

describe('failure and throttle behaviour', () => {
  it('a non-2xx writes NOTHING and falls back to the cache', async () => {
    await seedCache();
    fetchMock.mockResolvedValue(jsonResponse({ error: 'x' }, 503));
    const stampBefore = (await browser.storage.local.get(REMOTE_CONFIG_FETCHED_AT_KEY))[
      REMOTE_CONFIG_FETCHED_AT_KEY
    ];

    await expect(fetchRemoteConfig(true)).resolves.toEqual(CACHED);

    const stored = await browser.storage.local.get([REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_FETCHED_AT_KEY]);
    expect(stored[REMOTE_CONFIG_CACHE_KEY]).toEqual(CACHED);
    // The stamp is the debug console's "did a POST really land" signal — a failure must not advance it.
    expect(stored[REMOTE_CONFIG_FETCHED_AT_KEY]).toBe(stampBefore);
  });

  it('a rejected fetch (network down) falls back to the cache without throwing', async () => {
    await seedCache();
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await expect(fetchRemoteConfig(true)).resolves.toEqual(CACHED);
    debug.mockRestore();
  });

  it('honours the 1h throttle and lets force bypass it', async () => {
    await browser.storage.local.set({
      [REMOTE_CONFIG_CACHE_KEY]: CACHED,
      [REMOTE_CONFIG_FETCHED_AT_KEY]: Date.now() - 10_000, // fresh
    });
    await expect(fetchRemoteConfig()).resolves.toEqual(CACHED);
    expect(fetchMock).not.toHaveBeenCalled(); // throttled: no network on a respawn-shaped call

    fetchMock.mockResolvedValue(jsonResponse({ entries: CACHED }));
    await fetchRemoteConfig(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // force = the debug console's refresh button
  });

  it('a stale stamp really does re-fetch without force', async () => {
    await seedCache(); // stamp 2h old
    fetchMock.mockResolvedValue(jsonResponse({ entries: CACHED }));
    await fetchRemoteConfig();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reuses one persisted app_instance_id across fetches', async () => {
    // mockImplementation, NOT mockResolvedValue: a Response body reads exactly once, so serving the
    // same object twice makes the second call's .json() throw — the code under test then silently
    // exercises its failure fallback while the assertions below (which only read the REQUEST bodies)
    // still pass. Each call gets a fresh Response.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ entries: CACHED })));
    await fetchRemoteConfig(true);
    await fetchRemoteConfig(true);
    const bodies = fetchMock.mock.calls.map(
      (c) => (JSON.parse((c[1] as RequestInit).body as string) as { app_instance_id: string }).app_instance_id,
    );
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).toMatch(/^[0-9a-f-]{36}$/);
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

    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ entries: { [REMOTE_CONFIG_PARAM]: '{"tracker":{}}' } })),
    );
    await fetchRemoteConfig();

    await expect(hasFetchedRemoteConfig()).resolves.toBe(true);
  });

  it('stays false after a FAILED fetch, so the next spawn is still the first', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({}, 500)));
    await fetchRemoteConfig();
    await expect(hasFetchedRemoteConfig()).resolves.toBe(false);
  });

  it('is true after an entry-less 200, which is a real answer from the server', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ state: 'NO_TEMPLATE' })));
    await fetchRemoteConfig();
    await expect(hasFetchedRemoteConfig()).resolves.toBe(true);
  });

  it('is unaffected by a non-numeric stamp left by an older build', async () => {
    await browser.storage.local.set({ [REMOTE_CONFIG_FETCHED_AT_KEY]: 'yesterday' });
    await expect(hasFetchedRemoteConfig()).resolves.toBe(false);
  });
});
