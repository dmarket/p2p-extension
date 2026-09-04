import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveDmarketUrl } from '@/config/dmarketSite';
import { publishRemoteConfig } from '@/testing/stubs';

// The "Check DMarket" CTA resolver. The bug it exists for: on DM_SESSION_MISSING the popup opened prod
// dmarket.com while a debug build's core read the marketplace cookie from the FE the debug console had
// applied — so signing in fixed nothing and the button read as broken. Resolution order in a dev build:
// debug.feUrl (console) > WXT_DEV_FE_URL (build default) > web.dmarketUrl (compiled/remote config).
//
// `import.meta.env.DEV` is true under vitest, so the DEV chain is the branch under test — which is also
// the branch with all the logic (production is a one-line `return configured`). The machine's real .env
// leaks into import.meta.env here, so every test pins WXT_DEV_FE_URL itself (vi.stubEnv, undone by
// unstubEnvs) instead of inheriting whatever the checkout has.

/** Publish a `web.dmarketUrl`, or nothing (so the compiled default stands). */
const withConfiguredUrl = (url?: string): Promise<void> =>
  publishRemoteConfig(url === undefined ? {} : { web: { dmarketUrl: url } });

beforeEach(async () => {
  vi.stubEnv('WXT_DEV_FE_URL', '');
  await withConfiguredUrl(); // compiled default: https://dmarket.com/
});

describe('resolveDmarketUrl — the dev resolution chain', () => {
  it('answers the configured value when no dev default and no console override exist', async () => {
    await expect(resolveDmarketUrl()).resolves.toBe('https://dmarket.com/');
  });

  it('the build default substitutes the origin', async () => {
    vi.stubEnv('WXT_DEV_FE_URL', 'https://fe.dev.example/');
    await expect(resolveDmarketUrl()).resolves.toBe('https://fe.dev.example/');
  });

  it('the console override (debug.feUrl) wins over the build default', async () => {
    vi.stubEnv('WXT_DEV_FE_URL', 'https://fe.dev.example/');
    await browser.storage.local.set({ 'debug.feUrl': 'https://fe.console.example/' });
    await expect(resolveDmarketUrl()).resolves.toBe('https://fe.console.example/');
  });

  it('a cleared or non-string console value falls back to the build default', async () => {
    vi.stubEnv('WXT_DEV_FE_URL', 'https://fe.dev.example/');
    // The debug console records a CLEAR as an empty string — that must not beat the default here.
    await browser.storage.local.set({ 'debug.feUrl': '' });
    await expect(resolveDmarketUrl()).resolves.toBe('https://fe.dev.example/');
    await browser.storage.local.set({ 'debug.feUrl': 42 });
    await expect(resolveDmarketUrl()).resolves.toBe('https://fe.dev.example/');
  });

  it('a throwing storage read keeps the build default rather than failing the CTA', async () => {
    vi.stubEnv('WXT_DEV_FE_URL', 'https://fe.dev.example/');
    vi.spyOn(browser.storage.local, 'get').mockRejectedValue(new Error('gone'));
    await expect(resolveDmarketUrl()).resolves.toBe('https://fe.dev.example/');
  });

  it('carries a remote-config deep link (path + query + hash) onto the substituted origin', async () => {
    // The whole point of the URL re-composition: a published deep link must survive the origin swap
    // instead of being flattened to the FE root.
    await withConfiguredUrl('https://dmarket.com/ingame-items/item-list/csgo-skins?ref=x#top');
    vi.stubEnv('WXT_DEV_FE_URL', 'https://fe.dev.example/');
    await expect(resolveDmarketUrl()).resolves.toBe(
      'https://fe.dev.example/ingame-items/item-list/csgo-skins?ref=x#top',
    );
  });

  it('an unparseable resolved FE falls back to the configured value verbatim', async () => {
    await withConfiguredUrl('https://dmarket.com/deep/link');
    vi.stubEnv('WXT_DEV_FE_URL', 'not a url');
    await expect(resolveDmarketUrl()).resolves.toBe('https://dmarket.com/deep/link');
  });
});
