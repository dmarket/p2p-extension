import { getSettings } from '@/config/settings';

/**
 * The DMarket site URL a user-facing CTA must open, resolved against the FE the tracker is ACTUALLY
 * running against.
 *
 * Why this exists: the popup's "Check DMarket" button (DM_SESSION_MISSING) opened
 * `getSettings().web.dmarketUrl` — the prod origin, or whatever remote config published — while a debug
 * build's core reads the marketplace cookie from the FE the debug console last applied. Signing in on
 * dmarket.com therefore issued a cookie for an origin the core never looks at, so the block never
 * cleared and the button read as broken.
 *
 * Resolution order in a DEBUG build (mirrors the service worker's own FE chain — see
 * `bootCore` in src/entrypoints/background.ts):
 *   1. `debug.feUrl` — the debug console's applied FE (an explicit local operator action, so it wins);
 *   2. `WXT_DEV_FE_URL` — the build default a debug build boots against with no console override;
 *   3. `web.dmarketUrl` — the compiled/remote-config value.
 * A PRODUCTION build always takes (3): the whole dev branch is behind `import.meta.env.DEV`, a
 * compile-time constant, so it is dead code there.
 *
 * The path/query of `web.dmarketUrl` is carried over onto the resolved origin rather than discarded, so a
 * remote-config deep link keeps working when a dev origin is substituted. Total by construction: any
 * unparseable value falls back to `web.dmarketUrl` verbatim.
 */
export async function resolveDmarketUrl(): Promise<string> {
  const configured = getSettings().web.dmarketUrl;
  if (!import.meta.env.DEV) return configured;

  let devFeUrl = import.meta.env.WXT_DEV_FE_URL || '';
  try {
    // Key inlined rather than imported from @/debug/protocol: this module ships in every build, and the
    // debug tree does not exist in production.
    const stored = (await browser.storage.local.get('debug.feUrl'))['debug.feUrl'];
    if (typeof stored === 'string' && stored) devFeUrl = stored;
  } catch {
    /* storage unavailable — keep the build default */
  }
  if (!devFeUrl) return configured;

  try {
    const target = new URL(configured);
    return new URL(target.pathname + target.search + target.hash, devFeUrl).toString();
  } catch {
    return configured;
  }
}
