// Guard: the positional parameter orders in src/config/coreParams.ts must match the core's real
// constructors, read from the installed package's own `.d.mts`.
//
// This cannot be a type check. The seam imports the config classes through the
// `@dmarket/p2p-tracker-core-domain` Vite alias, whose types come from the HAND-WRITTEN ambient
// declaration in src/core/core-domain.d.ts — so `tsc` compares the orders against our own copy of the
// signatures, not against the core. When the core dropped `backoff` from `TrackerConfig` and
// `signatureAlg` / `teardownEveryNProofs` from `NotaryConfig`, the copy kept them, `tsc --noEmit` stayed
// green, and every group after the stale slot was written onto the wrong field: a `MarketplaceScrapeConfig`
// landed in `notary` (so `notary.enabled` read `undefined` and the prover could never be selected) and the
// configured FE origin was dropped on the floor. Nothing failed. This script is what fails.
//
// The rule is PREFIX, not equality: `copy()` is positional and stops at the last argument supplied, so an
// order may end early (the core's trailing `writeClaims` / `steamWrites` are simply not exposed). It may
// not skip, reorder, or invent a parameter — every index up to the order's length must name the same
// parameter the core has there.
//
// The single exception is `PENDING` below, which names individual trailing parameters that the core's main
// branch has but the installed snapshot does not yet. It is an exception to "invent", never to "skip" or
// "reorder", and it expires by failing.

import { readFileSync } from 'node:fs';

const DTS = 'node_modules/@dmarket/p2p-tracker-core/p2p-tracker-core.d.mts';
const PARAMS = 'src/config/coreParams.ts';

/** Which core class each order describes. Add a line when a group is added. */
const GROUPS = {
  CADENCE_ORDER: 'CadenceConfig',
  CREDENTIAL_ORDER: 'CredentialConfig',
  HTTP_ORDER: 'HttpConfig',
  MARKETPLACE_RETRY_ORDER: 'MarketplaceRetryConfig',
  MARKETPLACE_SCRAPE_ORDER: 'MarketplaceScrapeConfig',
  NOTARY_ORDER: 'NotaryConfig',
  STEAM_ENDPOINTS_ORDER: 'SteamEndpointsConfig',
  STEAM_PROFILE_ORDER: 'SteamProfileConfig',
  STEAM_SCRAPE_ORDER: 'SteamScrapeConfig',
  GAME_ORDER: 'GameConfig',
  TRACKER_ORDER: 'TrackerConfig',
};

/**
 * Parameters the CORE already declares but the INSTALLED package does not yet — the window between a core
 * commit and the npm publish that carries it.
 *
 * Why this exists at all: a core parameter is real the moment it is written in the core repo, and reaches
 * `node_modules` only when someone publishes. Without a hatch, the extension half of a two-repo change cannot
 * be written — appending the key to its `*_ORDER` makes this script report "N parameters listed but the core
 * takes N-1" and `npm run compile` fails — so the work waits on a release, which is the opposite of what a
 * remote-config knob is for. (The pending key is inert until the publish lands: `withOverrides` passes one
 * extra positional argument and the generated `copy()` ignores arguments past its arity.)
 *
 * The allowance is the narrowest shape that solves that, and specifically NOT "tolerate a longer order":
 *
 *  - It NAMES the parameter. A blanket "extra trailing entries are fine" would have accepted `rootStorePem`
 *    appended one slot early, which is a variant of the failure in this file's header — a PEM written into
 *    `offerRead`, types matching, nothing throwing.
 *  - It only holds at the END, and only once the non-pending prefix already covers the whole installed
 *    constructor. A pending entry in the MIDDLE re-maps every slot after it (the original bug), so a pending
 *    name landing on an index the installed core actually has is reported as an error, not waved through.
 *  - It DELETES ITSELF. The moment the installed `.d.mts` declares the parameter, this script FAILS and says
 *    to remove the entry. That is not pedantry: a pending allowance is an unchecked slot, and one that
 *    outlives its reason is a permanent hole in exactly the check the rest of this file performs. Failing
 *    loudly is the only way the hole cannot be forgotten — the ordinary prefix check then covers the slot for
 *    free, so removal costs one deleted line.
 *
 * Format: order name → trailing parameter names, in the order they appear at the end of that `*_ORDER`.
 */
const PENDING = {
  // Empty, as it should normally be. The last entry — `NotaryConfig.sentBudgetMarginPercent`, allowed here
  // ahead of the core's publish because an undersized send budget fails EVERY proof and the rollback could
  // not wait for a core release — retired when the installed snapshot reached `.186` and declared it. Per
  // the contract above, the ordinary prefix check now covers that slot; nothing here is needed for it.
};

const read = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    console.error(`check-core-params: cannot read ${p} — run \`npm install\` first.`);
    process.exit(2);
  }
};

const dts = read(DTS);
// Comments first: an order's entries are quoted strings, and a commented-out one would parse as real.
const params = read(PARAMS)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const core = {};
for (const m of dts.matchAll(/export declare class (\w+) \{\s*\n\s*constructor\(([^)]*)\)/g)) {
  core[m[1]] = m[2]
    .split(',')
    .map((s) => s.trim().split(/[?:]/)[0].trim())
    .filter(Boolean);
}

const orders = {};
for (const m of params.matchAll(/export const (\w+_ORDER)\s*=\s*\[([^\]]*)]/g)) {
  orders[m[1]] = [...m[2].matchAll(/["']([A-Za-z0-9_]+)["']/g)].map((x) => x[1]);
}

const problems = [];

for (const [order, cls] of Object.entries(GROUPS)) {
  const ours = orders[order];
  const theirs = core[cls];
  if (!ours) {
    problems.push(`${order}: not found in ${PARAMS} (renamed or removed?)`);
    continue;
  }
  if (!theirs) {
    problems.push(`${order} -> ${cls}: no such class in ${DTS} (renamed or removed in the core?)`);
    continue;
  }
  // Split the pending tail off first. Those slots have nothing in the installed core to compare against, so
  // everything below this point behaves exactly as it did before PENDING existed — the prefix check is not
  // relaxed for them, it simply has no counterpart to run against yet.
  const pending = PENDING[order] ?? [];
  const tail = pending.length ? ours.slice(-pending.length) : [];
  if (pending.length && tail.join() !== pending.join()) {
    problems.push(
      `${order}: PENDING lists [${pending}], which must be the LAST entries of the order in that exact ` +
        `order — found [${tail}]. A pending entry anywhere but the end re-maps every slot after it.`,
    );
    continue;
  }
  const checked = pending.length ? ours.slice(0, -pending.length) : ours;

  // Self-cleaning: once the installed core declares a pending parameter, the allowance has served its purpose
  // and must go, or the slot stays permanently unchecked.
  const arrived = pending.filter((name) => theirs.includes(name));
  for (const name of arrived) {
    problems.push(
      `${order} -> ${cls}: "${name}" is now declared by the installed core — delete it from PENDING in ` +
        `this script, so the ordinary prefix check covers the slot.`,
    );
  }

  // A pending parameter may only sit PAST the installed constructor's last argument. If the checked prefix
  // stops short, the pending name is being written onto a core parameter of a different name — which is the
  // mid-list shift this whole script exists to catch, arriving through the escape hatch. Suppressed when the
  // parameter has simply arrived, since that is the same slot seen from the other side and `arrived` already
  // says the one thing to do about it.
  if (pending.length && !arrived.length && checked.length < theirs.length) {
    problems.push(
      `${order} -> ${cls}: pending "${pending[0]}" sits at index ${checked.length}, but the installed core ` +
        `declares "${theirs[checked.length]}" there — a pending parameter may only follow the core's last ` +
        `argument, never occupy one.`,
    );
  }

  if (checked.length > theirs.length) {
    problems.push(
      `${order} -> ${cls}: ${checked.length} parameters listed but the core takes ${theirs.length}` +
        (pending.length ? ` (${pending.length} more are allowed for by PENDING)` : ''),
    );
  }
  for (let i = 0; i < Math.min(checked.length, theirs.length); i++) {
    if (checked[i] !== theirs[i]) {
      problems.push(`${order} -> ${cls}: index ${i} is "${checked[i]}" here but "${theirs[i]}" in the core`);
    }
  }
}

// A PENDING key naming an order that no longer exists is a stale allowance for nothing — same rot, so same
// treatment as an unmapped order below.
for (const order of Object.keys(PENDING)) {
  if (!(order in GROUPS)) problems.push(`PENDING.${order}: no such order in GROUPS — stale entry, remove it`);
}

// An order with no entry in GROUPS is unchecked, which is the failure mode this whole script exists to
// prevent — so it is an error, not a warning.
for (const order of Object.keys(orders)) {
  if (!(order in GROUPS)) problems.push(`${order}: no core class mapped in GROUPS — add one, or it goes unchecked`);
}

if (problems.length) {
  console.error('check-core-params: the override orders no longer match the core.\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    `\nEvery override past the first bad index is applied to the WRONG core field, silently.` +
      `\nFix ${PARAMS} (and the mirrored signatures in src/core/core-domain.d.ts) against ${DTS}.` +
      `\nA parameter the core has but this snapshot does not is the ONE case for PENDING in this script;` +
      `\nonce the snapshot catches up, the fix is to delete the PENDING entry, not to widen it.`,
  );
  process.exit(1);
}

// The pending count is printed on the happy path on purpose: it is the running total of slots this script is
// currently NOT verifying, and it should be visible in every green build until it is back to zero.
const pendingCount = Object.values(PENDING).flat().length;
console.log(
  `check-core-params: ${Object.keys(GROUPS).length} groups match the core` +
    (pendingCount ? `, ${pendingCount} parameter(s) pending a core publish.` : '.'),
);
