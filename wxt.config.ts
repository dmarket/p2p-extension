import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';
// The two match-pattern breadths, with the parse and the guard they share — see src/util/matchPattern.ts.
//
// RELATIVE, and it cannot be `@/util/matchPattern` however much the rest of the codebase uses that. The `@/*`
// alias exists only as a `paths` entry in .wxt/tsconfig.json, which is a TYPE-only mapping; this file is
// loaded at runtime by jiti (via c12), and jiti resolves with `require.resolve`, which does not read tsconfig
// paths. `tsc --noEmit` therefore stays green on the aliased form while every command that reads the config —
// `wxt prepare`, `build`, `dev`, `zip`, and vitest, whose plugin loads it too — dies with
// `Cannot find module '@/util/matchPattern'`. Same reason `./core-domain-alias` below is relative.
//
// The suppression is the load-bearing half: the IDE reads the same tsconfig `paths` and offers "Import can be
// shortened" here, which is how the aliased form got committed in the first place. Accepting that quick-fix
// breaks the build, and nothing in `tsc` or eslint catches it.
// noinspection ES6PreferShortImport
import { endpointMatchPattern, originMatchPattern } from './src/util/matchPattern';
// The domain-module alias, shared with vitest.config.ts so the two cannot resolve to different files.
import { CORE_DOMAIN_ALIAS } from './core-domain-alias';

const root = import.meta.dirname;
// The compiled core is the published npm package `@dmarket/p2p-tracker-core`. Its package.json
// resolves the runtime entry (`main` → .mjs, used by Vite) and the types (`types` → .d.mts, used by
// TypeScript) straight from node_modules — no alias needed for the main entry. Only the domain
// sub-module needs an explicit alias, and it is shared with the test run (see core-domain-alias.ts).
const stubs = resolve(root, 'src/core/stubs');

// Internal dev/stage endpoints come from the gitignored .env (WXT_DEV_*/WXT_STAGE_* — see
// .env.example) so the repository carries no internal hostnames. Read lazily (inside the manifest
// hook below): WXT loads .env files during config resolution, AFTER this module's top-level scope
// has already run, so process.env is only populated by hook time.
//
// Both helpers turn one variable into the 0-or-1 patterns the manifest needs, and both LOG a value they
// had to drop. An unset variable is the normal case and says nothing; a set-but-unparseable one is a typo
// that would otherwise be invisible — the manifest simply comes out without that host and the failure
// surfaces much later as CORS or a dead integration. (It used to be worse for the origin form: an
// unguarded `new URL()` threw a bare TypeError out of the hook, naming neither the variable nor the
// value.) Breadth and the parse live in src/util/matchPattern.ts, under test.
const patternFor = (
  build: (url: string | undefined) => string | undefined,
  name: string,
  url: string | undefined,
  logger: { warn: (msg: string) => void },
): string[] => {
  const pattern = build(url);
  if (pattern !== undefined) return [pattern];
  if (url?.trim()) logger.warn(`[manifest] ${name} is not a URL (${url}) — its host permission is omitted`);
  return [];
};

// Cookie-domain permissions for the dev/stage session cookies (WXT_DEV_COOKIE_DOMAINS, comma-separated
// registrable domains — see .env.example).
//
// Chrome gates cookies.getAll AND cookies.onChanged on a host permission for a URL derived from the
// COOKIE rather than from the page: `(secure ? https : http)://<Domain without leading dot>/`
// (chrome/browser/extensions/api/cookies/cookies_helpers.cc, AppendCookieToVectorIfMatchAndHasHostPermission
// — the same URL becomes the event_url that gates onChanged). So a dev cookie scoped to a parent domain,
// or served without Secure, is dropped from getAll and never raises an event even though the FE ORIGIN
// is permitted — which is why a dev-env login/logout was invisible while prod worked (prod's cookie
// derives to https://dmarket.com/, a pattern we already declare).
//
// `*://` covers both schemes because the derived scheme follows the cookie's Secure flag, and `*.<domain>`
// matches the bare domain as well as every subdomain. Deliberately broad, hence non-production only.
const cookieDomainPatterns = (list: string | undefined): string[] =>
  (list ?? '')
    .split(',')
    .map((d) => d.trim().replace(/^\.+/, ''))
    .filter((d) => d.length > 0)
    .map((d) => `*://*.${d}/*`);

/**
 * A build identifier for crash reports: the short git SHA plus the resolved core version.
 *
 * Neither is available at runtime with enough precision. `manifest.version` changes only when the
 * extension is released, so every build between two releases reports the same value — and the core's own
 * `trackerCoreVersion()` returns a bare marketing string (`'0.1.0-SNAPSHOT'` on a snapshot core), while
 * the version that actually identifies the installed package lives only in package-lock.json. Without
 * this, reports from a released build and from a local one an hour later would be indistinguishable, and
 * there would be no way to tell whether a report predates a fix.
 */
const buildId = (): string => {
  let sha = 'nogit';
  try {
    sha = execSync('git rev-parse --short HEAD', { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout (a tarball build) — the core version alone still distinguishes builds */
  }
  let core = 'unknown';
  try {
    const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };
    core = lock.packages?.['node_modules/@dmarket/p2p-tracker-core']?.version ?? core;
  } catch {
    /* no lockfile — leave it unknown rather than failing the build */
  }
  return `${sha}+core${core}`;
};

// WXT config — generates the MV3 manifest and drives the Vite build.
// Non-entrypoint modules live under src/ (srcDir), so the `@/` alias resolves to src/.
export default defineConfig({
  srcDir: 'src',
  // Force MV3 for every target. WXT defaults Firefox (and Safari) to MV2, but the extension is
  // MV3-only (chrome.action, declarativeNetRequest), so pin it here. (Setting manifest.manifest_version
  // directly is ignored by WXT — this option is the supported mechanism.)
  manifestVersion: 3,
  hooks: {
    // Copy the TLSN prover out of the core package and into the extension root.
    //
    // The core resolves it at runtime as `chrome.runtime.getURL('pkg/client_wasm.js')`, so the files
    // must exist at that path in the packed extension — a bundler cannot put them there, because they
    // must NOT be bundled: wasm-pack `--target web` resolves `spawn.js` and the `.wasm` through
    // `import.meta.url`, and inlining rewrites exactly those paths (green build, dead prover).
    //
    // Chrome only, matching the offscreen/COI manifest keys: shipping ~10 MB into a Firefox build that
    // cannot run the prover would be pure payload. Skipped silently when the installed core predates
    // the bump and carries no `pkg/`, so the build works either side of it.
    async 'build:done'(wxt) {
      if (wxt.config.browser === 'firefox') return;
      const core = resolve(root, 'node_modules/@dmarket/p2p-tracker-core');
      const out = wxt.config.outDir;
      for (const dir of ['pkg', 'transport']) {
        const from = resolve(core, dir);
        if (!existsSync(from)) {
          wxt.logger.warn(`[notary] ${dir}/ absent from the core package — prover not shipped`);
          continue;
        }
        await cp(from, resolve(out, dir), { recursive: true });
      }
    },
    // The debug console (`src/entrypoints/debug/`) is a dev-only tool. Drop it before WXT even loads
    // its code so nothing debug-related (Preact page, fetch-wrap, IndexedDB store) can reach a
    // production bundle. `wxt build` runs in `production` mode → excluded; `wxt` (dev) and
    // `wxt build --mode development` (the `build:debug` script) run in `development` mode → kept.
    // The hook's return value is ignored, so we mutate the array in place.
    'entrypoints:found'(wxt, entrypoints) {
      if (wxt.config.mode !== 'production') return;
      const i = entrypoints.findIndex((e) => e.name === 'debug');
      if (i !== -1) entrypoints.splice(i, 1);
    },
    // Dev/stage endpoints from .env, appended in NON-production builds only (prod manifest
    // unchanged; with an empty .env this whole hook is a no-op). FE origins go into both the
    // page-bridge content script's `matches` AND `host_permissions` — MV3 injects declarative
    // content scripts only on declared hosts, so both are required for the bridge to run there.
    // API hosts go into `host_permissions` only (no content script runs there): without the host
    // permission an MV3 service-worker fetch falls back to page-style CORS, and gateways that
    // don't allow extension origins kill every heartbeat as "Failed to fetch".
    // Cookie DOMAINS (WXT_DEV_COOKIE_DOMAINS) go into `host_permissions` only as well — never into
    // content-script `matches`, which would inject the page bridge across the whole domain. So does a
    // local Steam stand-in (WXT_DEV_STEAM_URL), for the same reason as an API host.
    'build:manifestGenerated'(wxt, manifest) {
      // Firebase Remote Config host — added in ALL modes, but only when the extension is actually
      // configured for Remote Config (all three WXT_FIREBASE_* set, the same gate as the runtime
      // isRemoteConfigEnabled()). A public clone with no Firebase keys keeps a minimal manifest; the
      // host itself is a fixed public Google endpoint (not derived from any secret). See
      // src/infra/remoteConfig.ts. (Read lazily from process.env — populated only by hook time.)
      if (
        process.env.WXT_FIREBASE_API_KEY &&
        process.env.WXT_FIREBASE_PROJECT_ID &&
        process.env.WXT_FIREBASE_APP_ID
      ) {
        manifest.host_permissions = [
          ...(manifest.host_permissions ?? []),
          // Narrowed to the one REST path the fetch uses
          // (`/v1/projects/<id>/namespaces/firebase:fetch?key=…`, src/infra/remoteConfig.ts): a host
          // permission is matched against the whole URL, path included, so there is no reason to take the
          // rest of the API surface. The trailing `*` covers the query string.
          'https://firebaseremoteconfig.googleapis.com/v1/*',
        ];
      }

      // Error-collector host — added in ALL modes, but only when WXT_COLLECTOR_URL is set (the same gate
      // as the runtime isCollectorEnabled()), so a public clone keeps a minimal manifest and reports
      // nowhere. Without the host permission an MV3 service-worker POST falls back to page-style CORS from
      // a `chrome-extension://<id>` origin the collector cannot allow-list.
      //
      // **Required, not optional** — deliberately, and the decision has a deadline attached (below).
      // `optional_host_permissions` would make reporting opt-in, and the grant can only ever be asked for
      // from a user gesture in an extension page: the service worker cannot ask, and a content script
      // cannot either, so the popup toggle would be the only place it could happen. That is a click almost
      // nobody makes, and the first crash a new user hits — the most valuable report there is — would
      // never arrive. Required + the popup's off switch is opt-OUT, which both stores allow for diagnostic
      // data provided the switch exists (src/ui/popup/ErrorReportingToggle.tsx).
      //
      // THE DEADLINE, and it cuts both ways: this must be in the FIRST published build. Adding a required
      // host permission in a later update is a privilege increase — Chrome disables the extension until
      // the user re-accepts, and on Firefox MV3 the host is not granted until the user answers a prompt.
      // Moving it from `optional_host_permissions` to here later costs exactly the same, which is why the
      // required/optional call is made before publishing rather than after.
      //
      // Narrowed to the collector's own path rather than its origin: a host permission is matched against
      // the whole URL, and `WXT_COLLECTOR_URL` is a BUILD-time variable, so a path change already means a
      // new release — narrowing therefore costs nothing that was not already spent. (The install warning
      // is generated per host, so this does not reduce it; it reduces blast radius, not consent.)
      manifest.host_permissions = [
        ...(manifest.host_permissions ?? []),
        ...patternFor(endpointMatchPattern, 'WXT_COLLECTOR_URL', process.env.WXT_COLLECTOR_URL, wxt.logger),
      ];

      // Dev/stage endpoints from .env, appended in NON-production builds only (prod manifest
      // otherwise unchanged; with an empty .env this whole block is a no-op).
      if (wxt.config.mode === 'production') return;
      const origin = (name: string): string[] =>
        patternFor(originMatchPattern, name, process.env[name], wxt.logger);
      const devCollectorHosts = patternFor(
        endpointMatchPattern,
        'WXT_DEV_COLLECTOR_URL',
        process.env.WXT_DEV_COLLECTOR_URL,
        wxt.logger,
      );
      const devFeHosts = [...origin('WXT_DEV_FE_URL'), ...origin('WXT_STAGE_FE_URL')];
      const devApiHosts = [...origin('WXT_DEV_API_URL'), ...origin('WXT_STAGE_API_URL')];
      // The local Steam stand-in (WXT_DEV_STEAM_URL): `host_permissions` only, like an API host — the
      // redirect happens inside the service worker's own fetch (src/background/dev-steam-redirect.ts) and
      // nothing is injected there. Independent of the endpoint pairs, since a stand-in Steam is just as
      // useful against the production DMarket endpoints.
      const devSteamHosts = origin('WXT_DEV_STEAM_URL');
      // The cookie-domain grants are independent of the endpoint pairs: they exist so cookie EVENTS for
      // the dev/stage session cookies reach us at all (see cookieDomainPatterns), so they are added even
      // if only this variable is set.
      const devCookieHosts = cookieDomainPatterns(process.env.WXT_DEV_COOKIE_DOMAINS);
      if (
        devFeHosts.length === 0 &&
        devApiHosts.length === 0 &&
        devSteamHosts.length === 0 &&
        devCookieHosts.length === 0 &&
        devCollectorHosts.length === 0
      ) {
        return;
      }
      manifest.host_permissions = [
        ...(manifest.host_permissions ?? []),
        ...devFeHosts,
        ...devApiHosts,
        ...devSteamHosts,
        ...devCookieHosts,
        // Never into content_scripts.matches — nothing is injected on the collector.
        ...devCollectorHosts,
      ];
      for (const cs of manifest.content_scripts ?? []) {
        if (cs.js?.some((j) => j.includes('dmarket-bridge'))) {
          cs.matches = [...(cs.matches ?? []), ...devFeHosts];
        }
      }
    },
  },
  // Function form so the Firefox-only keys are added per target. WXT does NOT strip
  // `browser_specific_settings` / extra permissions for Chrome, so they must be conditional — this
  // keeps the Chrome manifest byte-identical to the object form it replaced.
  manifest: ({ browser }) => {
    const firefox = browser === 'firefox';
    return {
      name: 'DMarket Trade Tracker BETA',
      description:
        'Tracks your Steam trade offers and verifies P2P trades against your DMarket deals.',
      permissions: [
        'storage',
        'cookies',
        'alarms',
        // NO `tabs`, deliberately — it carries the harshest install warning of any permission ("Read your
        // browsing history"), and nothing here needs it. `tabs.create` (every popup CTA) never required
        // it. The two `tabs.query({ url })` calls — the install/update re-injection in
        // src/background/inject-content-scripts.ts and the account-mismatch push in
        // src/entrypoints/background.ts — have their url filter honoured through `host_permissions` for
        // the matched tabs, and every pattern they filter on is a dmarket/steamcommunity origin listed
        // below. `tabs.sendMessage` is gated on host permission as well. No caller reads a privileged
        // `Tab` field (`url` / `pendingUrl` / `title` / `favIconUrl`) — `tab.id` and `tab.discarded` are
        // open to anyone. The tabs a query stops matching without it are exactly the tabs that never had
        // one of our content scripts, so there is nothing there to talk to anyway.
        //
        // It could not have been `optional_permissions` either: `permissions.request()` needs a user
        // gesture in an EXTENSION PAGE, and these calls run from the alarm-driven worker or from a popup
        // that its own CTA destroys — the same wall that killed the optional-host attempt for the
        // collector. And re-adding `tabs` in a later update IS a privilege increase (it generates a new
        // warning), so it would disable the extension for every user until they re-consent. Measure
        // before reaching for it.
        //
        // Programmatic injection of the page bridge into dmarket tabs that were already open when the
        // extension was installed/updated (src/background/inject-content-scripts.ts). Adds NO install warning of
        // its own — it only permits scripting hosts already listed in `host_permissions`, which is where
        // the warning comes from. Ship it in the first published build regardless of whether the
        // injection is enabled: unlike a host permission, adding `scripting` later is not a privilege
        // increase, but it is a needless update either way.
        'scripting',
        'declarativeNetRequestWithHostAccess',
        // Chrome only: hosts the TLSN prover. The tracker loop runs in the service worker, which cannot
        // run it — no `Worker` constructor there, and Chrome documents cross-origin isolation as not
        // fully implemented for service workers. Firefox's MV3 background is an event page where
        // `Worker` exists, and it has no chrome.offscreen API at all, so it is excluded.
        ...(firefox ? [] : ['offscreen']),
        // Firefox rewrites the Steam anti-CSRF headers via blocking webRequest instead of DNR
        // (see src/background/anti-csrf.ts). Chrome does not get these permissions.
        ...(firefox ? ['webRequest', 'webRequestBlocking'] : []),
      ],
      // Cross-origin isolation for the prover. The multi-threaded WASM needs SharedArrayBuffer at ANY
      // thread count (its `initialize` unconditionally starts a worker spawner and a rayon pool), and
      // extension pages get isolation from these manifest keys rather than from response headers.
      // `require-corp` also blocks cross-origin subresources that have not opted in — nothing this
      // extension loads is cross-origin, but keep that in mind before adding any.
      // Chrome-only: Firefox has not shipped isolation for extension pages.
      ...(firefox
        ? {}
        : {
            cross_origin_embedder_policy: { value: 'require-corp' },
            cross_origin_opener_policy: { value: 'same-origin' },
            // The prover compiles WebAssembly and spawns workers; the default extension CSP forbids both.
            content_security_policy: {
              extension_pages: "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';",
            },
            // The prover is fetched by URL at runtime from the extension root (wasm-pack `--target web`
            // resolves `spawn.js` and the `.wasm` through `import.meta.url`), so both directories must be
            // reachable as resources. `pkg/` MUST stay loose — inlining it rewrites exactly those paths.
            web_accessible_resources: [
              {
                resources: ['pkg/*', 'transport/*'],
                matches: [],
                extension_ids: [],
              },
            ],
          }),
      host_permissions: [
        'https://dmarket.com/*',
        'https://www.dmarket.com/*',
        'https://api.dmarket.com/*',
        'https://steamcommunity.com/*',
        'https://login.steampowered.com/*',
        'https://store.steampowered.com/*',
        'https://api.steampowered.com/*',
      ],
      // Firefox add-on identity (required for MV3 loading/signing). Ignored by Chrome, hence gated.
      ...(firefox
        ? {
            browser_specific_settings: {
              gecko: {
                // TODO(release): replace with the real AMO add-on id.
                id: 'dmarket-trade-tracker@dmarket.com',
                // 140 is the first Firefox with the built-in data-collection consent UI, which is what
                // gates the error reporter below. Below it, `permissions.getAll()` has no
                // `data_collection` key at all, so the toggle could claim "on" while nothing is ever
                // sent. The add-on is unpublished, so there is no installed base to strand by requiring it.
                strict_min_version: '140.0',
                // Error reporting (message + stack + extension version + the dmarket analytics device id)
                // is Mozilla's `technicalAndInteraction` — "Device and browser info, extension usage and
                // settings data, crash and error reports". It is valid ONLY in `optional`, which also makes
                // it opt-in on Firefox: nothing is sent until the user grants it from the popup toggle.
                // Nothing else is collected, hence `required: ['none']`.
                data_collection_permissions: {
                  required: ['none'],
                  optional: ['technicalAndInteraction'],
                },
              },
            },
          }
        : {}),
    };
  },
  vite: () => ({
    plugins: [preact()],
    // A crash report's stack is otherwise unreadable: background.js is ~1.2 MB on ~57 lines, so every
    // frame renders as `background.js:34:120345`. 'hidden' emits the maps without a sourceMappingURL
    // comment, so nothing ships a pointer to them — archive them per release to symbolicate.
    build: {
      // Vite injects a `<link rel="modulepreload">` into every HTML entrypoint for each shared chunk
      // of that entry. Chrome refuses to reuse a preloaded `chrome-extension://` resource across
      // script worlds (`Resource::CanReuse` → `kCrossWorldExtensionResourceMismatch`, behind the
      // `kPreventExtensionResourceFetchAcrossIsolatedWorlds` feature), so the preload NEVER matches
      // the real module fetch: the chunk is fetched twice and every page load logs two console
      // warnings ("preloaded … but not used" + the mismatch). There is nothing to gain either way —
      // these are local extension resources, with no network latency to hide. The entry chunk still
      // imports them statically, so the module graph loads exactly the same files.
      //
      // `false` also drops Vite's modulepreload polyfill, which is dead code on both targets (Chrome
      // MV3; the Firefox floor is 140 and modulepreload landed in 115) and currently ships ~700 B
      // inside the shared `browser-*` chunk that every extension page loads.
      modulePreload: false as const,
      sourcemap: 'hidden' as const,
      rollupOptions: {
        // The core now VENDORS the TLSN prover and loads it by RELATIVE path
        // (`./pkg/client_wasm.js`, `./transport/dist/index.js`) from inside its own package — it no
        // longer emits the bare `client-wasm` / `client-wasm-transport` specifiers we used to alias to
        // a stub. Those files really exist in node_modules, so Rollup would happily inline them: ~10 MB
        // of glue plus a `new Worker(new URL('./spawn.js', import.meta.url))` and a `.wasm` fetched via
        // `import.meta.url`. Inlining rewrites exactly those two paths, which is how you get a green
        // build with a dead prover.
        //
        // Only the BARE spellings remain load-bearing, and only until the core bump lands: the current
        // published snapshot still emits `import('client-wasm')`, while the new core resolves the prover
        // from a runtime URL, so it emits no analysable specifier at all and needs nothing here. Drop
        // these two once package.json no longer resolves to a pre-bump snapshot.
        external: [/^client-wasm$/, /^client-wasm-transport$/],
      },
    },
    define: {
      // Injected because neither half is knowable at runtime — see buildId() above.
      __BUILD_ID__: JSON.stringify(buildId()),
    },
    resolve: {
      // Runtime-only stubs for the core's lazy dynamic imports that are unused in the browser build.
      // (Not TypeScript aliases: our code never imports these; only the bundler resolves them.)
      alias: [
        { find: /^ws$/, replacement: resolve(stubs, 'ws.ts') },
        // The core's config classes (TrackerConfig/MarketplaceScrapeConfig) live in the domain module and
        // are NOT re-exported from the package main. The seam (src/core/tracker.ts) imports them from
        // here to build a config (e.g. the FE-endpoint override). Resolves to the same file the core's
        // own relative import uses, so it's the same module instance (class identity preserved) — which
        // is why the test run has to resolve it identically, hence the shared constant.
        CORE_DOMAIN_ALIAS,
      ],
    },
  }),
});
