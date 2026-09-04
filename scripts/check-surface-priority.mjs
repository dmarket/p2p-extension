// Guard: the user-facing state priority in src/state/surface.ts must stay exactly what the product asked
// for — no DMarket session > no Steam session > wrong Steam account > not activated > anything else — and
// src/core/blockingReason.ts must keep mapping every value the core can report (including the two
// pre-rename spellings) onto it. Since the dev console now RENDERS that chain from a table
// (src/debug/blockingStates.ts), the table is checked against the real resolver too: a documented order
// that the code does not implement is worse than none, because it is read as authoritative.
//
// This cannot be a type check, and it is not something a reviewer reliably catches: `resolveSurface` is a
// chain of early returns, so moving one line silently changes which prompt every surface shows, and each
// of the three surfaces looks perfectly reasonable on its own. The ordering has already been wrong once in
// each direction (the activation prompt above every block; the wrong-account prompt below an unactionable
// backend error, which the prod 404-by-design heartbeat made permanently unreachable).
//
// The core has the matching guard on its side of the seam — it decides WHICH single reason reaches us:
// domain/src/commonTest/.../BlockingStateTest.kt. Both must be updated together, deliberately.
//
// Run by `npm run compile`. All three modules are import-free by design (the catalog's two imports are
// type-only), so esbuild-bundling them yields the real implementations rather than a copy, and the script
// asserts the full truth table against them.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE = 'src/state/surface.ts';
const REASON_MODULE = 'src/core/blockingReason.ts';
const CATALOG_MODULE = 'src/debug/blockingStates.ts';
const CORE_DOMAIN = 'node_modules/@dmarket/p2p-tracker-core/dmarket-p2p-tracker-core-domain.mjs';

/** Every reason that can reach a surface, most-blocking first. Mirrors `BlockingReason` at the seam. */
const REASONS = [
  'DM_SESSION_MISSING',
  'STEAM_SESSION_MISSING',
  'STEAM_ACCOUNT_MISMATCH',
  'DM_CONNECTION_ERROR',
  'UNKNOWN',
  'NONE',
];

/**
 * The contract, as the ranked list of (condition -> state) rules it is. `resolveSurface` must behave
 * exactly like walking this table top-down and taking the first match.
 */
const PRIORITY = [
  { state: 'DM_SESSION_MISSING', when: (activated, reason) => reason === 'DM_SESSION_MISSING' },
  { state: 'STEAM_SESSION_MISSING', when: (activated, reason) => reason === 'STEAM_SESSION_MISSING' },
  { state: 'STEAM_ACCOUNT_MISMATCH', when: (activated, reason) => reason === 'STEAM_ACCOUNT_MISMATCH' },
  { state: 'NOT_ACTIVATED', when: (activated) => !activated },
  { state: 'BLOCKED', when: (activated, reason) => reason !== 'NONE' },
  { state: 'ACTIVE', when: () => true },
];

const expected = (activated, reason) => PRIORITY.find((rule) => rule.when(activated, reason)).state;

/**
 * Every value the seam must map, and to what. The two legacy spellings are the pre-rename core's own
 * names (`MISSING_CONNECTION`/`CONNECTION_ERROR`), which this build still has to translate — for the
 * value already persisted on an updated install, and for as long as the installed core predates the
 * rename. Getting that wrong shows the neutral "paused" prompt where "sign into DMarket" belongs.
 */
const NORMALIZE = {
  DM_SESSION_MISSING: 'DM_SESSION_MISSING',
  STEAM_SESSION_MISSING: 'STEAM_SESSION_MISSING',
  STEAM_ACCOUNT_MISMATCH: 'STEAM_ACCOUNT_MISMATCH',
  DM_CONNECTION_ERROR: 'DM_CONNECTION_ERROR',
  NONE: 'NONE',
  MISSING_CONNECTION: 'DM_SESSION_MISSING',
  CONNECTION_ERROR: 'DM_CONNECTION_ERROR',
  SOME_FUTURE_CORE_STATE: 'UNKNOWN',
  '': 'NONE',
};

const dir = mkdtempSync(join(tmpdir(), 'dmp-surface-'));
let resolveSurface;
let normalizeBlockingReason;
let BLOCKING_STATES;
try {
  const bundle = (source, name) => {
    const out = join(dir, name);
    execFileSync(
      'node_modules/.bin/esbuild',
      [source, '--bundle', '--format=esm', '--log-level=warning', `--outfile=${out}`],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    );
    return import(`file://${out}`);
  };
  ({ resolveSurface } = await bundle(MODULE, 'surface.mjs'));
  ({ normalizeBlockingReason } = await bundle(REASON_MODULE, 'reason.mjs'));
  ({ BLOCKING_STATES } = await bundle(CATALOG_MODULE, 'catalog.mjs'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failures = [];
let checked = 0;

// Every combination, including the unresolved ones: an input still being read from storage must be
// LOADING — a surface must never guess a screen while a storage read is in flight.
for (const activated of [true, false, undefined]) {
  for (const reason of [...REASONS, undefined]) {
    const got = resolveSurface(activated, reason);
    checked += 1;
    if (activated === undefined || reason === undefined) {
      if (got !== 'LOADING') failures.push(`resolveSurface(${activated}, ${reason}) = ${got}, want LOADING`);
      continue;
    }
    const want = expected(activated, reason);
    if (got !== want) failures.push(`resolveSurface(${activated}, ${reason}) = ${got}, want ${want}`);
  }
}

// The ranking itself, asserted pairwise: for each higher-priority rule, a state that would also satisfy a
// lower one must still resolve to the higher. Catches a reordering that happens to keep the table above
// self-consistent (e.g. someone "fixes" both the module and one case here).
const RANK_PROBES = [
  { higher: 'DM_SESSION_MISSING', reason: 'DM_SESSION_MISSING', activated: false, lower: 'NOT_ACTIVATED' },
  { higher: 'STEAM_SESSION_MISSING', reason: 'STEAM_SESSION_MISSING', activated: false, lower: 'NOT_ACTIVATED' },
  { higher: 'STEAM_ACCOUNT_MISMATCH', reason: 'STEAM_ACCOUNT_MISMATCH', activated: false, lower: 'NOT_ACTIVATED' },
  { higher: 'NOT_ACTIVATED', reason: 'DM_CONNECTION_ERROR', activated: false, lower: 'BLOCKED' },
  { higher: 'NOT_ACTIVATED', reason: 'UNKNOWN', activated: false, lower: 'BLOCKED' },
];
for (const probe of RANK_PROBES) {
  const got = resolveSurface(probe.activated, probe.reason);
  checked += 1;
  if (got !== probe.higher) {
    failures.push(`${probe.higher} must outrank ${probe.lower}: got ${got} for reason=${probe.reason}, activated=${probe.activated}`);
  }
}

// Fail closed: an activated user with a reason this build does not understand must never read as ACTIVE.
if (resolveSurface(true, 'UNKNOWN') === 'ACTIVE') failures.push('an unrecognised reason resolved to ACTIVE');
checked += 1;

// The seam's allow-list, including the legacy aliases and the fail-closed default.
for (const [raw, want] of Object.entries(NORMALIZE)) {
  const got = normalizeBlockingReason(raw);
  checked += 1;
  if (got !== want) failures.push(`normalizeBlockingReason(${JSON.stringify(raw)}) = ${got}, want ${want}`);
}
for (const raw of [undefined, null, 42, {}]) {
  const got = normalizeBlockingReason(raw);
  checked += 1;
  if (got !== 'NONE') failures.push(`normalizeBlockingReason(${JSON.stringify(raw)}) = ${got}, want NONE`);
}

// ---- the dev console's state catalog ---------------------------------------------------------------
//
// src/debug/blockingStates.ts is what the debug console RENDERS as the priority chain (and what the
// force-tick note is written from). A table that documents an order the code does not implement is worse
// than no table at all — it is read as authoritative — so it is checked here rather than by eye.
// `UNKNOWN` is deliberately absent from the catalog: the core never emits it (it is the host's fail-closed
// default for a reason a newer core reports), so there is no cause an operator could reproduce and nothing
// to put in a row. Its fail-closed RENDERING is asserted above, against resolveSurface itself.
const catalogReasons = BLOCKING_STATES.map((s) => s.reason);
const wantCatalogReasons = [...REASONS.filter((r) => r !== 'UNKNOWN' && r !== 'NONE'), 'NOT_ACTIVATED', 'NONE'];
checked += 1;
if (catalogReasons.length !== new Set(catalogReasons).size) {
  failures.push(`${CATALOG_MODULE}: a reason appears more than once (${catalogReasons.join(', ')})`);
}
for (const reason of wantCatalogReasons) {
  checked += 1;
  if (!catalogReasons.includes(reason)) failures.push(`${CATALOG_MODULE}: no row for ${reason}`);
}
for (const reason of catalogReasons) {
  checked += 1;
  if (!wantCatalogReasons.includes(reason)) failures.push(`${CATALOG_MODULE}: row for unknown reason ${reason}`);
}
// Ranks: 1..n, unique and contiguous, in declaration order — the panel renders the array as written, so a
// rank that disagrees with its position would number the rows wrongly on screen.
BLOCKING_STATES.forEach((state, i) => {
  checked += 1;
  if (state.rank !== i + 1) failures.push(`${CATALOG_MODULE}: ${state.reason} has rank ${state.rank} at position ${i + 1}`);
});
// The load-bearing one: walking the catalog top-down and taking the first row that MATCHES must give the
// same answer as the real resolveSurface, for every input. This is what stops the table from drifting away
// from the chain the three surfaces actually run. `UNKNOWN` is skipped — it has no row by design.
const catalogSurface = (activated, reason) =>
  BLOCKING_STATES.find((s) => (s.activation === true ? !activated : s.reason === reason))?.surface;
for (const activated of [true, false]) {
  for (const reason of REASONS.filter((r) => r !== 'UNKNOWN')) {
    checked += 1;
    const got = catalogSurface(activated, reason);
    const want = resolveSurface(activated, reason);
    if (got !== want) {
      failures.push(
        `${CATALOG_MODULE}: walking the catalog for (activated=${activated}, ${reason}) gives ${got}, but resolveSurface gives ${want}`,
      );
    }
  }
}

// ---- the INSTALLED core's own precedence -----------------------------------------------------------
//
// The host cannot re-rank what the core already collapsed into one value, so our order only takes effect
// if the installed core agrees with it. This is a WARNING, not a failure, on purpose: the only way to fix a
// disagreement is a core publish (push -> CI snapshot -> `npm run core:latest`), which is outside this
// repo — failing here would block every unrelated change on someone else's CI. It exists because the
// alternative is what actually happened: the extension shipped the right order, the published core still
// had the old one, and the only symptom was the wrong prompt on screen with nothing anywhere saying why.
//
// Read out of the compiled `BlockingState.resolve` body rather than trusting the version number: the
// method name is minified and changes per build, but the body is one line of nested ternaries returning
// `TrackerBlock_<NAME>_getInstance()` in precedence order, ending in NONE.
const coreOrderWarnings = [];
try {
  const compiled = readFileSync(CORE_DOMAIN, 'utf8');
  const body = compiled
    .split('\n')
    .find((line) => line.includes('TrackerBlock_NONE_getInstance()') && line.includes('?'));
  if (body === undefined) {
    coreOrderWarnings.push(`could not find BlockingState.resolve in ${CORE_DOMAIN} — the compiled shape changed`);
  } else {
    const order = [...body.matchAll(/TrackerBlock_([A-Z_]+)_getInstance\(\)/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'NONE');
    const want = REASONS.filter((r) => r !== 'UNKNOWN' && r !== 'NONE');
    if (order.join(' > ') !== want.join(' > ')) {
      coreOrderWarnings.push(`installed core resolves ${order.join(' > ')}`);
      coreOrderWarnings.push(`this build expects  ${want.join(' > ')}`);
    }
  }
} catch (error) {
  coreOrderWarnings.push(`could not read ${CORE_DOMAIN}: ${error.message}`);
}

if (coreOrderWarnings.length > 0) {
  console.warn('\n⚠  The INSTALLED core does not report reasons in this build\'s priority order.\n');
  for (const warning of coreOrderWarnings) console.warn(`   ${warning}`);
  console.warn(
    '\n   Until the core snapshot carrying the new order is published and installed, the popup / banner /' +
      '\n   icon will show whichever reason the OLD core picked — e.g. "sign into Steam" while the user is' +
      '\n   also signed out of DMarket. Fix: push the core, wait for the CI snapshot, then' +
      '\n   `npm run core:latest` and rebuild. Nothing in this repo can work around it.\n',
  );
}

if (failures.length > 0) {
  console.error(`\n${MODULE} / ${REASON_MODULE}: the user-facing state priority is wrong.\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nIntended order: no DMarket session > no Steam session > wrong Steam account > not activated >' +
      '\nanything else blocking > active. If the product decision really changed, change the PRIORITY table' +
      '\nin this script, the core\'s BlockingStateTest, and say so in both changelogs.\n',
  );
  process.exit(1);
}

console.log(
  `${MODULE} + ${REASON_MODULE} + ${CATALOG_MODULE}: state priority + reason allow-list + console catalog OK (${checked} cases).`,
);
