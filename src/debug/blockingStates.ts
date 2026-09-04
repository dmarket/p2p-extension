// The blocking-state chain, as data: one entry per state a user-facing surface can show, in the order
// the extension resolves them. Dev-only (this whole tree is stripped from production builds).
//
// Why it exists: the precedence and the per-state trigger conditions were prose in four places — the
// `BlockingReason` KDoc (src/core/blockingReason.ts), the header of src/state/surface.ts, the PRIORITY
// table in scripts/check-surface-priority.mjs, and `blockedNote()` in src/debug/router.ts. The debug
// console's own state panel would have been a fifth copy, and this codebase has already paid for exactly
// that kind of duplication (see the LIFECYCLE_PROBLEMS drift in src/ui/debug/LogViewer.tsx). So the panel
// AND the router's force-tick note both read this table, and scripts/check-surface-priority.mjs executes
// it against the real `resolveSurface`, which makes a drifted table a `npm run compile` failure.
//
// ZERO runtime imports, on purpose: the guard script bundles this module with esbuild and imports it in
// node, so a value import of anything that touches `browser` (or the 1 MB core) would break it. Both
// imports below are type-only and erased at build time — the same discipline documented in
// src/core/blockingReason.ts.

import type { BlockingReason } from '@/core/blockingReason';
import type { SurfaceState } from '@/state/surface';
import type { ScenarioId } from '@/debug/simulationState';

/**
 * A row of the chain. `reason` is what the core reports (or the host's own `'UNKNOWN'`), except for the
 * one host-owned row: activation is not a core state at all, so it is spelled with its `SurfaceState`
 * name and matched on the activation flag instead.
 */
export interface BlockingStateInfo {
  /** 1-based position in the chain. Unique, contiguous — asserted by the guard script. */
  rank: number;
  /** The core reason this row describes, or `'NOT_ACTIVATED'` for the host-owned activation row. */
  reason: BlockingReason | 'NOT_ACTIVATED';
  /** What `resolveSurface` returns for this row — the guard script checks this against the real function. */
  surface: SurfaceState;
  /** Short human name, for the reference list's heading. */
  title: string;
  /**
   * Two-word label for the switcher chip. Separate from [title] because the switcher packs all six states
   * into one wrapping strip in a 460px column, where a full title costs a whole line.
   */
  short: string;
  /** What makes the tracker enter this state. */
  cause: string;
  /** What makes it go away, and whether it survives a worker respawn. */
  clears: string;
  /** What the user actually sees: popup screen, Steam on-page banner, toolbar icon. */
  surfaces: string;
  /** The storage keys this state writes or deletes, so a reader knows what to watch. */
  keys: readonly string[];
  /** The simulator scenario that reproduces this state's CAUSE, or `undefined` when there is none. */
  scenario?: ScenarioId;
  /**
   * Set on the one row that is not a core state: its checkbox is a live view of `activation.enabled`,
   * written directly. There is nothing to simulate about the host's own flag — and binding the checkbox
   * to the flag itself is also what removes any "value before the simulation" to remember and restore.
   */
  activation?: true;
  /** Extra note rendered under the row (used where the mechanism or the reachability is unusual). */
  note?: string;
}

/**
 * The chain, most-blocking first. Mirrors `resolveSurface` (src/state/surface.ts) — which folds the
 * host-owned activation flag into the core's own precedence — NOT the core's `BlockingState.resolve`
 * alone. The order is the product decision; see that module's header for why onboarding sits below the
 * three sign-in states.
 *
 * Keep the copy SHORT. This is a reference table an operator scans while arming a scenario, not
 * documentation: one line per field, the reasoning in comments where it belongs.
 *
 * `UNKNOWN` is deliberately NOT a row: it is host-synthesised for a reason the core never emits (a newer
 * core than this build), so there is no cause to reproduce and nothing an operator can do with it. It still
 * renders as blocked — that is asserted in scripts/check-surface-priority.mjs, not here.
 */
export const BLOCKING_STATES: readonly BlockingStateInfo[] = [
  {
    rank: 1,
    reason: 'DM_SESSION_MISSING',
    surface: 'DM_SESSION_MISSING',
    title: 'No DMarket session',
    short: 'No DMarket',
    cause: 'No DMarket session cookie at the FE origin, so the cycle stops before the heartbeat.',
    clears: 'Any usable credential, no heartbeat needed. Not persisted.',
    surfaces: 'Popup "Check DMarket". No Steam banner. Red icon.',
    keys: [],
    scenario: 'dm-session-missing',
  },
  {
    rank: 2,
    reason: 'STEAM_SESSION_MISSING',
    surface: 'STEAM_SESSION_MISSING',
    title: 'No Steam session',
    short: 'No Steam',
    cause: 'The steamcommunity.com session cookie is gone, or the token inside it expired.',
    clears: 'The next acquired credential, same cycle. Persisted, so it survives a respawn.',
    surfaces: 'Popup "Open Steam". No Steam banner. Red icon.',
    keys: ['loop_steam_session_missing', 'loop_steam_mint_attempted', 'steam_credential (deleted)'],
    scenario: 'steam-session-missing',
  },
  {
    rank: 3,
    reason: 'STEAM_ACCOUNT_MISMATCH',
    surface: 'STEAM_ACCOUNT_MISMATCH',
    title: 'Wrong Steam account',
    short: 'Wrong account',
    cause: "A successful heartbeat's linkedSteamId differs from the Steam id of the credential we hold.",
    clears: 'A credential for another account (no heartbeat needed), or a matching heartbeat. Persisted.',
    surfaces: 'Popup "Wrong Steam account" + the id. The only state with a Steam page banner. Red icon.',
    keys: ['loop_steam_mismatch_token_id', 'loop_steam_mismatch_rechecked', 'tracker.linkedSteamId'],
    scenario: 'steam-account-mismatch',
    note: "Dev/stage only: prod's heartbeat 404s, so there is no response to rewrite.",
  },
  {
    rank: 4,
    reason: 'NOT_ACTIVATED',
    surface: 'NOT_ACTIVATED',
    title: 'Onboarding not completed',
    short: 'Not activated',
    cause: "activation.enabled is not true — the host's own flag, not a core state.",
    clears: 'Finishing onboarding, or the checkbox here.',
    surfaces: 'Popup onboarding. Steam onboarding banner. Grey icon.',
    keys: ['activation.enabled'],
    activation: true,
    note: 'Below the sign-in states: two of them make onboarding impossible. Writes the real flag.',
  },
  {
    rank: 5,
    reason: 'DM_CONNECTION_ERROR',
    surface: 'BLOCKED',
    title: 'DMarket unreachable',
    short: 'DMarket error',
    cause: 'The heartbeat reached DMarket and failed non-401: a 4xx at once, a 5xx or network error after 2.',
    clears: 'The first heartbeat that round-trips. Only the failure streak is persisted.',
    surfaces: 'Popup "Can\'t reach DMarket". No banner. Red icon, grey if not activated.',
    keys: ['loop_server_error_count'],
    scenario: 'dm-connection-error',
    note: "Last: the user cannot act on it, and prod's 404-by-design keeps it set.",
  },
  {
    rank: 6,
    reason: 'NONE',
    surface: 'ACTIVE',
    title: 'Nothing blocking',
    short: 'Normal',
    cause: 'The DMarket session is usable and the browser is on the linked Steam account.',
    clears: '-',
    surfaces: 'Popup "Trade tracking is ON". Active banner. Green icon.',
    keys: [],
  },
];

/** The row describing [reason], or `undefined` for a value outside the chain. */
export const blockingStateInfo = (reason: BlockingReason): BlockingStateInfo | undefined =>
  BLOCKING_STATES.find((s) => s.reason === reason);

/**
 * One line explaining what a non-`NONE` reason means, for the debug console's visible command log (a
 * forced tick that could not do what it was asked). Sourced from the table above so the console cannot
 * describe a state differently from how it documents it.
 */
export function blockingStateNote(reason: BlockingReason): string {
  const info = blockingStateInfo(reason);
  if (info === undefined) {
    return `blocked with a reason this build does not recognise (${reason}) — the core is newer than the console; treat it as blocked.`;
  }
  return `${info.title.toLowerCase()}: ${info.cause} ${info.clears}`;
}
