// Guard: a built output directory is the artifact we meant to ship.
//
// This mechanises the checks that were being re-run by hand after every build ("prod has no debug
// symbols, no debug.html, manifest unchanged, 6 permissions, 9 hosts"). Run by CI on every push, for
// both modes, and again by the release job against the manifest it is about to tag.
//
// Usage:
//   node scripts/verify-build.mjs <outDir|manifest.json> --mode production|development
//                                 [--require-derived-hosts]
//
// A `manifest.json` path runs the manifest half only (what the release job has in its workspace); a
// directory runs everything. All failures are collected and printed together — a red build should tell
// you everything that is wrong, not just the first thing.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

// ── The privilege lock ────────────────────────────────────────────────────────────────────────────
//
// EDITING EITHER LIST BELOW IS THE DELIBERATE ACT OF ACCEPTING A PRIVILEGE CHANGE. It is a
// hand-maintained duplicate of wxt.config.ts on purpose: adding a permission or a host to a published
// extension is a privilege increase, and Chrome then DISABLES the extension for every existing user
// until they re-accept it (Firefox withholds the host until the user answers a prompt). That is
// irreversible in the sense that matters — you cannot take it back after the update ships. So the cost
// of the duplicate (update it in two places) is the point: it makes the change visible in review.
//
// Order matters. Both are compared as sequences, because the manifest generator produces them in a
// fixed order and a reordering is a signal that something else changed.
const EXPECTED_PERMISSIONS = [
  'storage',
  'cookies',
  'alarms',
  'scripting',
  'declarativeNetRequestWithHostAccess',
  'offscreen',
];

// The origins hard-coded in wxt.config.ts's `manifest` block.
const STATIC_HOSTS = [
  'https://dmarket.com/*',
  'https://www.dmarket.com/*',
  'https://api.dmarket.com/*',
  'https://steamcommunity.com/*',
  'https://login.steampowered.com/*',
  'https://store.steampowered.com/*',
  'https://api.steampowered.com/*',
];

// Appended by the `build:manifestGenerated` hook when the corresponding variables are set, in this
// order. Deliberately NOT keyed on process.env here: this script has to give the same verdict when it
// is run later, in another shell, against an already-built directory. So the rule is "the static hosts
// followed by these two, each optional" — which still catches an unexpected host, an unexpected
// ORDER, and a host that vanished. `--require-derived-hosts` is what demands both (see below).
const DERIVED_HOSTS = [
  { name: 'Firebase Remote Config', pattern: 'https://firebaseremoteconfig.googleapis.com/v1/*' },
  { name: 'error collector', pattern: 'https://t.dmarket.com/v1/collect*' },
];

// Dev-only tooling that must not reach a production bundle. `src/debug/` is dropped by an
// `import.meta.env.PROD` guard plus a dynamic import, so a leak here means a static import crept in.
//
// STRING LITERALS ONLY, and that is not a style choice: the build minifies, so identifiers are
// mangled and a grep for `registerDebugRouter` / `installNetLog` matches nothing even in the DEBUG
// bundle — a check that can never fire while reading as if it protects something. Every entry below
// is verified present in a development build (so it would be detected) and absent from a production
// one.
const DEBUG_SYMBOLS = [
  'p2p-debug-log', // the IndexedDB store name (debug/sessionLog.ts)
  'debug:describe', // the dev router's message vocabulary (debug/protocol.ts)
  'debug:set-simulation',
  'debug:retry-proof',
  'debug:force-tick',
  'dmp-simulated-absent', // the blocking-state simulator's cookie-name substitute
];

// The production notary WebSocket, asserted present in the shipped bytes because its absence is
// otherwise completely silent: a bundle carrying no notary URL runs the no-op prover, which submits an
// empty `proofPayload`, so every deal the backend marks `proofRequired` stalls with nothing in the build
// saying why. A dev build legitimately carries the .env notary instead, so this is production-only.
//
// An independent literal, like EXPECTED_PERMISSIONS above and for the same reason — an expectation
// derived from the source it checks would follow a typo straight into the bundle. What it verifies is
// only that SOME shipped script carries the string: `src/config/notaryUrl.ts` is unit-tested for the
// resolution itself, and once the core publish lands its own default is a second occurrence, at which
// point this can no longer tell the two apart. Pinning them to each other needs the core's constant read
// at runtime (a test against the domain module) — worth adding as soon as that const is installed.
const PROD_NOTARY_URL = 'wss://api.dmarket.com/provenance/v1/';

// The dev-only fetch wraps (debug/netLog.ts, debug/simulate.ts, background/dev-steam-redirect.ts).
// Any of them in production means the whole service worker's HTTP is being intercepted in a shipped
// build.
const FETCH_WRAP = /globalThis\s*\.\s*fetch\s*=/;

// Vendored third-party payload, copied in by the `build:done` hook. Excluded from the source greps
// (it is upstream's code, verified against its own published checksums in the core repo's CI) and
// asserted present instead: the hook WARNS and continues when the core package carries no `pkg/`, so
// a build with no prover in it is currently silent.
const VENDORED_DIRS = ['pkg', 'transport'];
const REQUIRED_VENDORED = ['pkg/client_wasm_bg.wasm', 'pkg/client_wasm.js', 'transport/dist/index.js'];

const failures = [];
const fail = (msg) => failures.push(msg);
const notes = [];

// ── Arguments ─────────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith('-'));
const modeIndex = argv.indexOf('--mode');
const mode = modeIndex === -1 ? undefined : argv[modeIndex + 1];
const requireDerived = argv.includes('--require-derived-hosts');

if (!target || (mode !== 'production' && mode !== 'development')) {
  console.error(
    'usage: node scripts/verify-build.mjs <outDir|manifest.json> --mode production|development [--require-derived-hosts]',
  );
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`verify-build: ${target} does not exist — build first.`);
  process.exit(2);
}

const manifestOnly = target.endsWith('.json');
const outDir = manifestOnly ? undefined : target;
const manifestPath = manifestOnly ? target : join(outDir, 'manifest.json');

if (!existsSync(manifestPath)) {
  console.error(`verify-build: ${manifestPath} not found.`);
  process.exit(2);
}

/** @type {Record<string, unknown>} */
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(`verify-build: ${manifestPath} is not valid JSON — ${e.message}`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// ── Manifest: version ─────────────────────────────────────────────────────────────────────────────
//
// package.json's `version` is the single source of truth (the release is triggered by editing exactly
// that field), but Chrome accepts only 1-4 dot-separated integers, each 0..65535, with no leading
// zeros beyond a bare "0" and NO prerelease suffix. So WXT splits a SemVer prerelease across two
// fields — `simplifyVersion` in wxt/dist/core/utils/manifest.mjs takes the numeric prefix into
// `manifest.version` and puts the full string in `manifest.version_name` (which is what Chrome shows
// on the extension card). `1.0.0-beta.1` therefore ships as version 1.0.0 / version_name
// 1.0.0-beta.1, and asserting the two fields are equal to package.json would fail a correct build.
//
// What is checked instead: `version` is the numeric prefix of the package version AND is loadable,
// and `version_name` says exactly what the package version says — the full string when there is a
// suffix, and nothing at all when there is not (WXT omits the field when it would just repeat
// `version`). Both directions matter, and each has its own failure: a build that dropped the suffix
// installs as a bare 1.0.0 that no release can be traced to, and a build that KEPT a stale suffix
// shows "1.0.0-beta.1" on the extension card while the release is tagged v1.0.0.
// NOTE: WXT omits `version_name` on Firefox builds, which this script never inspects.
const VERSION_RE = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/;
const numericPrefix = /^((0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3})/.exec(pkg.version)?.[1];
if (manifest.version !== numericPrefix) {
  fail(
    `manifest.version is "${manifest.version}" but package.json's "${pkg.version}" reduces to ` +
      `"${numericPrefix}"`,
  );
}
if (typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) {
  fail(
    `manifest.version "${manifest.version}" is not a Chrome extension version ` +
      '(1-4 dot-separated integers, no prerelease suffix)',
  );
} else if (manifest.version.split('.').some((p) => Number(p) > 65535)) {
  fail(`manifest.version "${manifest.version}" has a part above 65535 — Chrome rejects it`);
}
const expectedVersionName = pkg.version === numericPrefix ? undefined : pkg.version;
if (manifest.version_name !== expectedVersionName) {
  fail(
    `manifest.version_name is ${JSON.stringify(manifest.version_name)} but package.json's ` +
      `"${pkg.version}" calls for ${JSON.stringify(expectedVersionName)}`,
  );
}
if (manifest.manifest_version !== 3) {
  fail(`manifest_version is ${manifest.manifest_version}, expected 3`);
}

// ── Manifest: permissions + hosts (production only) ───────────────────────────────────────────────
//
// The development manifest legitimately carries extra hosts (every WXT_DEV_*/WXT_STAGE_* endpoint and
// the cookie-domain grants), and which ones depends on the environment the build ran in — so there is
// nothing stable to lock there. Production is the surface that ships.
if (mode === 'production') {
  const seq = (a) => JSON.stringify(a ?? null);
  if (seq(manifest.permissions) !== seq(EXPECTED_PERMISSIONS)) {
    fail(
      'production `permissions` changed — this is a PRIVILEGE CHANGE, see the lock in this file.\n' +
        `        expected: ${seq(EXPECTED_PERMISSIONS)}\n` +
        `        actual:   ${seq(manifest.permissions)}`,
    );
  }

  const hosts = manifest.host_permissions ?? [];
  const staticPart = hosts.slice(0, STATIC_HOSTS.length);
  if (seq(staticPart) !== seq(STATIC_HOSTS)) {
    fail(
      'production `host_permissions` no longer starts with the static origins — this is a PRIVILEGE ' +
        'CHANGE, see the lock in this file.\n' +
        `        expected: ${seq(STATIC_HOSTS)}\n` +
        `        actual:   ${seq(staticPart)}`,
    );
  }
  // The tail must be the derived hosts, in order, each optional and nothing else.
  const tail = hosts.slice(STATIC_HOSTS.length);
  const present = [];
  let cursor = 0;
  for (const derived of DERIVED_HOSTS) {
    if (tail[cursor] === derived.pattern) {
      present.push(derived);
      cursor += 1;
    }
  }
  const unexpected = tail.slice(cursor);
  if (unexpected.length > 0) {
    fail(
      `production \`host_permissions\` carries ${unexpected.length} unexpected host(s): ` +
        `${seq(unexpected)} — a PRIVILEGE CHANGE, or a dev host leaking into a production build`,
    );
  }
  for (const derived of DERIVED_HOSTS) {
    if (present.includes(derived)) continue;
    const msg =
      `the ${derived.name} host permission (${derived.pattern}) is absent — the build ran without ` +
      'its WXT_* variables';
    // Absent is legitimate for a local build or a public clone with no .env. It is NOT legitimate for
    // a release: those two hosts must be in the FIRST published build, because adding a host later
    // disables the extension for every user until they re-consent — the same deadline the collector
    // comment in wxt.config.ts spells out.
    if (requireDerived) fail(`${msg}. A release artifact MUST carry it.`);
    else notes.push(msg);
  }
}

// ── Files ─────────────────────────────────────────────────────────────────────────────────────────
if (!manifestOnly) {
  /** Every file under `dir`, as paths relative to outDir, skipping the vendored payload. */
  const walk = (dir, acc = []) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative(outDir, full);
      if (VENDORED_DIRS.includes(rel)) continue;
      if (statSync(full).isDirectory()) walk(full, acc);
      else acc.push(rel);
    }
    return acc;
  };
  const files = walk(outDir);
  // `.map` files are excluded from the source greps: `sourcemap: 'hidden'` embeds background.ts's own
  // source, which legitimately names `debug/boot` and `debug.apiBaseUrl` in the dead branch it
  // tree-shakes. The shipped JS is what the assertion is about.
  const scripts = files.filter((f) => f.endsWith('.js'));

  if (mode === 'production') {
    for (const f of ['debug.html']) {
      if (files.includes(f)) fail(`${f} is present in a production build`);
    }
    const debugChunks = scripts.filter((f) => basename(f).startsWith('debug-'));
    if (debugChunks.length > 0) {
      fail(`debug chunk(s) in a production build: ${debugChunks.join(', ')}`);
    }
    // One pass, one read per file: the notary-URL check rides the loop rather than re-reading every
    // script (2.5 MB of the 2.7 MB total, since the file that carries the URL sorts second).
    let notaryUrlFound = false;
    for (const f of scripts) {
      const source = readFileSync(join(outDir, f), 'utf8');
      const found = DEBUG_SYMBOLS.filter((s) => source.includes(s));
      if (found.length > 0) fail(`${f} carries dev-only symbol(s): ${found.join(', ')}`);
      if (FETCH_WRAP.test(source)) fail(`${f} wraps globalThis.fetch in a production build`);
      if (!notaryUrlFound && source.includes(PROD_NOTARY_URL)) notaryUrlFound = true;
    }
    for (const f of REQUIRED_VENDORED) {
      if (!existsSync(join(outDir, f))) {
        fail(`${f} is missing — the prover was not copied in (the build:done hook only warns)`);
      }
    }
    if (!notaryUrlFound) {
      fail(`no script carries the production notary URL (${PROD_NOTARY_URL}) — the prover would be the no-op one`);
    }
  } else {
    // The inverse guard: prove the debug build really is one. `wxt build` without `--mode development`
    // produces a directory that looks fine and silently has no debug console in it.
    if (!files.includes('debug.html')) {
      fail('debug.html is absent from a development build — was --mode development passed?');
    }
    if (!scripts.some((f) => basename(f).startsWith('debug-'))) {
      fail('no debug chunk in a development build');
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────────
const label = manifestOnly ? manifestPath : outDir;
for (const note of notes) console.log(`verify-build: note — ${note}`);
if (failures.length > 0) {
  console.error(`\nverify-build: ${label} (${mode}) FAILED ${failures.length} check(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('');
  process.exit(1);
}
console.log(`verify-build: ${label} (${mode}) OK — v${manifest.version}, manifest and payload as expected.`);
