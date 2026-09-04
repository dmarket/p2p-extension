// The core's blocking-reason vocabulary, and the single allow-list for a value crossing into the
// extension. Deliberately its OWN module, with ZERO imports: it is pure host logic (no core symbols), it is
// read by every surface, and keeping it free of the 1 MB core is what lets scripts/check-surface-priority.mjs
// execute the real allow-list instead of a copy of it. Re-exported from @/core/tracker, which is where a
// reader expects the core's surface to live.

/**
 * The single prioritized reason the tracker is blocked, as resolved by the core (priority already
 * applied: `DM_SESSION_MISSING` > `STEAM_SESSION_MISSING` > `STEAM_ACCOUNT_MISMATCH` >
 * `DM_CONNECTION_ERROR` > `NONE` — most actionable and most upstream first, which is also the order in
 * which a core cycle establishes them). The client never recomputes THIS priority — it reads one value and
 * renders one prompt; where the host-owned activation flag sits in the same chain is decided in
 * `state/surface.ts`. The `DM_` pair names the axis and the kind: `SESSION_MISSING` is a login problem,
 * `CONNECTION_ERROR` is the backend being unreachable.
 *   - `DM_SESSION_MISSING`     — no working DMarket session (the `dm-trade-token` is absent/invalid and
 *                                could not be refreshed); heartbeat can't pass. Highest priority: nothing
 *                                works without it, and it is the first thing every cycle checks.
 *   - `STEAM_SESSION_MISSING`  — no Steam web session at all (the session cookie is gone), so the core
 *                                can't get a Steam credential and the cycle stops before the heartbeat.
 *                                A login problem, on the Steam side.
 *   - `STEAM_ACCOUNT_MISMATCH` — the browser is signed into a Steam account other than the linked one.
 *                                Released by a credential naming a different account, which needs no
 *                                heartbeat — which is why it safely outranks `DM_CONNECTION_ERROR`.
 *   - `DM_CONNECTION_ERROR`    — the `/heartbeat` reached DMarket but it returned a non-401 error (a
 *                                deterministic 4xx like 404, or a persistent 5xx). The session token is
 *                                fine; DMarket itself is unreachable. A single transient blip is NOT this
 *                                (the core requires a repeated failure). Lowest priority: the user cannot
 *                                act on it, and the prod route answers 404 by design, so anything ranked
 *                                below it would never be displayed.
 *   - `UNKNOWN`                — host-synthesised, never reported by the core: a value this build does
 *                                not recognise (see {@link normalizeBlockingReason}). Rendered as
 *                                blocked-but-unactionable, never as "everything is fine".
 *   - `NONE`                   — nothing blocking.
 */
export type BlockingReason =
  | 'NONE'
  | 'STEAM_ACCOUNT_MISMATCH'
  | 'DM_CONNECTION_ERROR'
  | 'DM_SESSION_MISSING'
  | 'STEAM_SESSION_MISSING'
  | 'UNKNOWN';

/** Every reason the core itself can report — i.e. {@link BlockingReason} minus the host's `UNKNOWN`. */
const CORE_BLOCKING_REASONS: readonly BlockingReason[] = [
  'NONE',
  'STEAM_ACCOUNT_MISMATCH',
  'DM_CONNECTION_ERROR',
  'DM_SESSION_MISSING',
  'STEAM_SESSION_MISSING',
];

/**
 * The two names a pre-rename core reports, and the two a pre-rename build persisted under
 * `tracker.blockingReason`. Kept so this build is correct against BOTH the installed core and the value
 * already sitting in `storage.local` on an updated install — without them a mirrored `MISSING_CONNECTION`
 * would fail closed to `'UNKNOWN'` and every surface would show the neutral "paused" prompt instead of
 * "sign into DMarket", for one cycle after an update and for the whole of a build that predates the core
 * bump. Drop this map once the published core floor is past the rename (core CHANGELOG, `TrackerBlock`).
 */
const LEGACY_BLOCKING_REASONS: Readonly<Record<string, BlockingReason>> = {
  MISSING_CONNECTION: 'DM_SESSION_MISSING',
  CONNECTION_ERROR: 'DM_CONNECTION_ERROR',
};

/**
 * The single allow-list for a blocking reason crossing into the extension, from the core or from
 * storage. **Fails closed:** an unrecognised non-empty value becomes `'UNKNOWN'` (which every surface
 * renders as blocked), never `'NONE'`.
 *
 * That matters because the core's `blockingReason()` is typed as a bare `string` in the generated
 * `.d.mts`, so TypeScript cannot catch a core that grows a state this build has never heard of — and the
 * one thing a client must never do is claim "trade tracking is ON" for a state it does not understand.
 * Absent/blank (no core value yet) is the honest `'NONE'`.
 */
export function normalizeBlockingReason(value: unknown): BlockingReason {
  if (typeof value !== 'string' || value === '') return 'NONE';
  if (CORE_BLOCKING_REASONS.includes(value as BlockingReason)) return value as BlockingReason;
  return LEGACY_BLOCKING_REASONS[value] ?? 'UNKNOWN';
}
