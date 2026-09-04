// Guard: src/core/createTradeOutcome.ts maps the CORE's coded create-trade cause onto the page's closed
// `CreateTradeFailureReason` set, so the two vocabularies must not drift apart — and the mapping itself must
// keep answering correctly for the outcome shapes the core really emits.
//
// This cannot be a type check. The core's cause arrives as a string in a JSON body: a core that grows a cause
// leaves `tsc --noEmit` perfectly green while that cause quietly maps to `OTHER`, which is precisely the bug
// this seam was written to fix (a user at Steam's 5-offers-per-partner cap being told only "failed"). Nothing
// would fail. This script is what fails.
//
// Three things are asserted, and they fail differently on purpose:
//   1. PARITY (hard failure) — every `SteamCreateFailureCause` member the installed core can emit has an
//      entry in this build's map. Fixable right here, so it blocks the build: a cause with no entry means a
//      cause the core recognises reaches the page as a bare `OTHER`.
//   2. BEHAVIOUR (hard failure) — the real `resolveCreateTradeOutcome`, esbuild-bundled and executed (the
//      module is import-free by design, so this is the implementation and not a copy), against fixtures that
//      include the verbatim outcome from the original report.
//   3. CORE FLOOR (warning) — the installed core actually reports a `cause`. Only a core publish can fix
//      that (push -> CI snapshot -> `npm run core:latest`), so failing here would block every unrelated
//      change in this repo on someone else's CI — the same rule check-surface-priority.mjs applies to the
//      core's blocking-reason order, and for the same reason.
//
// Run by `npm run compile`, alongside check-core-params.mjs and check-surface-priority.mjs.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODULE = 'src/core/createTradeOutcome.ts';
const PROTOCOL = 'src/messaging/protocol.ts';
const CORE_DOMAIN = 'node_modules/@dmarket/p2p-tracker-core/dmarket-p2p-tracker-core-domain.mjs';
const CORE_FACADE = 'node_modules/@dmarket/p2p-tracker-core/p2p-tracker-core.mjs';

const read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    console.error(`check-create-trade-cause: cannot read ${path} — run \`npm install\` first.`);
    process.exit(2);
  }
};

const dir = mkdtempSync(join(tmpdir(), 'dmp-create-cause-'));
let CAUSE_REASONS;
let mapCoreCause;
let throttleScopeReason;
let resolveCreateTradeOutcome;
let isCreateTradeFailureReason;
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
  ({ CAUSE_REASONS, mapCoreCause, throttleScopeReason, resolveCreateTradeOutcome } = await bundle(MODULE, 'outcome.mjs'));
  ({ isCreateTradeFailureReason } = await bundle(PROTOCOL, 'protocol.mjs'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const problems = [];
let checked = 0;

// ---- 1. parity with the installed core's cause vocabulary -------------------------------------------
//
// Read off the compiled enum's singleton holders rather than trusting a version number: member names survive
// minification (they are part of the generated identifier), the accessor names do not.
//   var SteamCreateFailureCause_COUNTERPARTY_OFFER_LIMIT_instance;
const coreCauses = [
  ...new Set(
    [...read(CORE_DOMAIN).matchAll(/SteamCreateFailureCause_([A-Z_]+)_instance/g)].map((match) => match[1]),
  ),
];

// The core emits the field as `put_0(builder, 'cause', …)` in its create-trade outcome builder. Checked
// separately from the enum: a core could in principle carry the type without reporting it, and it is the
// REPORTING that this seam depends on.
const coreReportsCause = /put_0\([^,]+, 'cause',/.test(read(CORE_FACADE));

if (coreCauses.length === 0 || !coreReportsCause) {
  console.warn('\n⚠  The INSTALLED core does not report a coded create-trade cause.\n');
  console.warn(`   ${CORE_DOMAIN}: ${coreCauses.length} SteamCreateFailureCause members found`);
  console.warn(`   ${CORE_FACADE}: reports \`cause\` = ${coreReportsCause}`);
  console.warn(
    '\n   Until the core snapshot carrying it is published and installed, every Steam refusal reaches the' +
      '\n   page as a bare "OTHER" — the page then renders "failed" with no cause for a limit that has one,' +
      '\n   which is the exact bug this seam exists to fix. Fix: publish the core, wait for the CI snapshot,' +
      '\n   then `npm run core:latest` and rebuild. Nothing in this repo can work around it.\n',
  );
} else {
  for (const cause of coreCauses) {
    checked += 1;
    if (!(cause in CAUSE_REASONS)) {
      problems.push(`the core can report cause "${cause}" and ${MODULE} has no entry for it (it would read as OTHER)`);
    }
  }
  for (const cause of Object.keys(CAUSE_REASONS)) {
    checked += 1;
    if (!coreCauses.includes(cause)) {
      problems.push(`${MODULE} maps cause "${cause}" and the installed core cannot report it — dead entry, or a rename`);
    }
  }
}

// Whatever the core reports, the value we map it to must be one the page's own set admits.
for (const [cause, reason] of Object.entries(CAUSE_REASONS)) {
  checked += 1;
  if (!isCreateTradeFailureReason(reason)) {
    problems.push(`${MODULE} maps "${cause}" to "${reason}", which ${PROTOCOL} does not admit`);
  }
}

// ---- 2. the mapping, on the values the core actually produces ---------------------------------------

for (const [cause, want] of [
  ['COUNTERPARTY_OFFER_LIMIT', 'LIMIT_COUNTERPARTY'],
  ['OUTGOING_OFFER_LIMIT', 'LIMIT_OUTGOING'],
  ['TRANSPORT', 'NETWORK'],
  // Request throttling is not a cap on open offers and must not be dressed up as one: the page's set has no
  // member for "wait, then retry", and "cancel some offers" is advice this user cannot act on.
  ['REQUEST_RATE_LIMITED', 'OTHER'],
  ['OTHER', 'OTHER'],
  // Fail closed: a cause from a newer core, junk, and the absent field an older core leaves behind.
  ['SOME_FUTURE_CAUSE', 'OTHER'],
  ['toString', 'OTHER'],
  [undefined, 'OTHER'],
  [null, 'OTHER'],
  [42, 'OTHER'],
]) {
  checked += 1;
  const got = mapCoreCause(cause);
  if (got !== want) problems.push(`mapCoreCause(${JSON.stringify(cause)}) = ${got}, want ${want}`);
}

for (const [scope, want] of [
  ['partner', 'LIMIT_COUNTERPARTY'],
  ['global', 'OTHER'],
  ['unknown', 'OTHER'],
  [undefined, 'OTHER'],
]) {
  checked += 1;
  const got = throttleScopeReason(scope);
  if (got !== want) problems.push(`throttleScopeReason(${JSON.stringify(scope)}) = ${got}, want ${want}`);
}

// ---- 3. the outcome seam, on the shapes the core emits ----------------------------------------------
//
// Every `status` the core's create-trade JSON builder can write, plus the two ways it can write none. The
// load-bearing property: no failing arm may reach the bridge without a `reason`, and nothing malformed may
// ever come back `ok: true`.

// The verbatim outcome the core produced for the reported failure — Steam 500 + strError, per-counterparty
// cap — now carrying the cause the core reads off it. This is the case that shipped as a bare `OTHER`.
const REPORTED = {
  ok: false,
  status: 'failed',
  error:
    'Steam create returned HTTP 500: {"strError":"You have sent too many trade offers, or have too many ' +
    'outstanding trade offers with luckydm07. Please cancel some before sending more."}',
  cause: 'COUNTERPARTY_OFFER_LIMIT',
};

const OUTCOMES = [
  [JSON.stringify(REPORTED), { ok: false, reason: 'LIMIT_COUNTERPARTY' }],
  [JSON.stringify({ ok: true, status: 'created', steamOfferId: '42' }), { ok: true }],
  [JSON.stringify({ ok: true, status: 'needs_confirmation', steamOfferId: '42', duplicate: true }), { ok: true }],
  // A success the core reported without an offer id stays a success: the offer is on Steam, and the page's
  // remedy for a failure is to retry, which is how one create becomes two.
  [JSON.stringify({ ok: true, status: 'needs_confirmation' }), { ok: true }],
  [JSON.stringify({ ok: false, status: 'failed', error: 'boom', cause: 'TRANSPORT' }), { ok: false, reason: 'NETWORK' }],
  // A failure the core could not classify, and one from a core that classified nothing at all.
  [JSON.stringify({ ok: false, status: 'failed', error: 'boom', cause: 'OTHER' }), { ok: false, reason: 'OTHER' }],
  [JSON.stringify({ ok: false, status: 'failed', error: 'boom' }), { ok: false, reason: 'OTHER' }],
  [JSON.stringify({ ok: false, status: 'throttled', scope: 'partner', retryAfterSeconds: 30 }), { ok: false, reason: 'LIMIT_COUNTERPARTY' }],
  [JSON.stringify({ ok: false, status: 'throttled', scope: 'global', retryAfterSeconds: 30 }), { ok: false, reason: 'OTHER' }],
  [JSON.stringify({ ok: false, status: 'create_in_flight', duplicate: true }), { ok: false, reason: 'OTHER' }],
  [JSON.stringify({ ok: false, status: 'account_mismatch', linkedSteamId: '1', tokenSteamId: '2' }), { ok: false }],
  // Degrades rather than emitting a half-filled mismatch the page would render with blank ids.
  [JSON.stringify({ ok: false, status: 'account_mismatch' }), { ok: false, reason: 'OTHER' }],
  [JSON.stringify({ ok: false, error: 'missing deal_id (the outcome report requires it)' }), { ok: false, reason: 'OTHER' }],
  // Fail closed: unparseable, not an object, and a status from a core newer than this build.
  ['not json at all', { ok: false, reason: 'OTHER' }],
  ['[]', { ok: false, reason: 'OTHER' }],
  [JSON.stringify({ ok: true, status: 'some_future_status', cause: 'COUNTERPARTY_OFFER_LIMIT' }), { ok: false, reason: 'LIMIT_COUNTERPARTY' }],
];

for (const [json, want] of OUTCOMES) {
  const got = resolveCreateTradeOutcome(json);
  checked += 1;
  if (got.ok !== want.ok) problems.push(`resolveCreateTradeOutcome(${json.slice(0, 50)}…).ok = ${got.ok}, want ${want.ok}`);
  if (want.reason !== undefined && got.reason !== want.reason) {
    problems.push(`resolveCreateTradeOutcome(${json.slice(0, 50)}…).reason = ${got.reason}, want ${want.reason}`);
  }
  // The invariant the page depends on: a failure the bridge can build an ack from always names a cause.
  checked += 1;
  if (!got.ok && got.status !== 'account_mismatch' && got.reason === undefined) {
    problems.push(`resolveCreateTradeOutcome(${json.slice(0, 50)}…) is a failure with no reason`);
  }
}

// ---- 4. the bridge's gate accepts every code we can produce -----------------------------------------
//
// The whole point of mapping is that a real code reaches the page, and the LAST thing between the two is
// `isCreateTradeFailureReason` in src/messaging/protocol.ts — the runtime allow-list the bridge runs on this
// value (it arrives there across an unvalidated message boundary, so it must be checked). A code this seam
// emits that the allow-list rejects would be silently rewritten to `OTHER`: the exact failure being fixed,
// reintroduced one layer further along and invisible to `tsc`.
for (const reason of new Set(OUTCOMES.map(([json]) => resolveCreateTradeOutcome(json).reason).filter((r) => r !== undefined))) {
  checked += 1;
  if (!isCreateTradeFailureReason(reason)) {
    problems.push(`${PROTOCOL} rejects "${reason}", so the bridge would rewrite it to OTHER`);
  }
}

if (problems.length > 0) {
  console.error('check-create-trade-cause: the create-trade seam no longer matches the core.\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\nA cause the core reports but this build does not map reaches the page as a bare "OTHER" —` +
      `\nthe page then renders "failed" with no cause for a Steam limit that has one.` +
      `\nFix ${MODULE} against ${CORE_DOMAIN} (SteamCreateFailureCause).`,
  );
  process.exit(1);
}

console.log(`check-create-trade-cause: ${checked} assertions pass against the installed core.`);
