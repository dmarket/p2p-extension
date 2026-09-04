// Shared test stubs. Imported by *.test.ts files only — nothing under src/entrypoints/ reaches this
// directory, so it is invisible to the build (same colocation argument as the tests themselves; the
// prod bundle is grepped for test symbols in the verification pass).
//
// Deliberately minimal: what more than one test file needs, plus the two fixtures whose TRAPS are worth
// documenting once ({@link jsonResponse}, {@link flushMacrotasks}) rather than in each caller.

import { vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_PARAM } from '@/infra/remoteConfig';
import { loadSettings } from '@/config/settings';

/**
 * Give the fake browser a manifest. Its own `runtime.getManifest` THROWS "not implemented", which is
 * itself a useful state (it exercises `hostPermissionOrigins`' catch path in src/config/settings.ts —
 * "no manifest → host/base-URL overrides rejected"); call this for the granted-host path.
 *
 * A spy rather than an assignment, so `restoreMocks: true` (vitest.config.ts) puts the throwing
 * original back after each test — an assignment would leak the stub across the whole file.
 */
export function stubManifest(hostPermissions: string[]): void {
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'test',
    version: '0.0.0',
    host_permissions: hostPermissions,
  });
}

/**
 * Replace `globalThis.fetch` with a mock and return it for scripting/assertions. Undone automatically
 * after each test by `unstubGlobals: true` (vitest.config.ts). The default implementation rejects, so a
 * test that expects no network learns about an unexpected request from a loud failure, not a hang.
 */
export function stubFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>(() => Promise.reject(new Error('unexpected fetch in test')));
  vi.stubGlobal('fetch', mock);
  return mock;
}

/**
 * A canned JSON `Response` for {@link stubFetch} implementations.
 *
 * TRAP: a Response body reads exactly once. `mock.mockResolvedValue(jsonResponse(…))` hands the SAME
 * object to every call, so the second call's `.json()` throws "Body is unusable" — which the code under
 * test typically catches and turns into its failure fallback, i.e. the test keeps passing while quietly
 * exercising the wrong path. For a mock that answers more than once, wrap it:
 * `mock.mockImplementation(() => Promise.resolve(jsonResponse(…)))`.
 */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/**
 * Let the queued macrotasks run.
 *
 * The one step every storage/messaging test in this suite needs and the most subtle thing in it: this
 * codebase's cross-context notifications are `storage.onChanged` listeners and its relays are
 * fire-and-forget (`void sendMessage().then(…)`), so the effect of an awaited write lands a turn or two
 * LATER. Named, because five call sites spelled it inline and the reader had to recognise the idiom.
 *
 * Prefer `vi.waitFor(...)` when there is something to poll for — it is both faster and self-documenting.
 * Reach for this when the assertion is that NOTHING happened, which no amount of polling can establish.
 */
export async function flushMacrotasks(turns = 1): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Publish `doc` as the cached Remote Config document and load it into the settings snapshot, the way a
 * fetch would. `doc` is the parsed shape — the double wrapping (one param, whose value is the document as
 * a JSON *string*) is the storage contract from src/infra/remoteConfig.ts and belongs in one place.
 */
export async function publishRemoteConfig(doc: unknown): Promise<void> {
  await fakeBrowser.storage.local.set({
    [REMOTE_CONFIG_CACHE_KEY]: { [REMOTE_CONFIG_PARAM]: JSON.stringify(doc) },
  });
  await loadSettings();
}
