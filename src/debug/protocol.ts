// Typed contracts for the dev-only debug console <-> service-worker channel.
//
// This whole module tree (`src/debug/*` + `src/entrypoints/debug/*`) is DEV-ONLY: it is dynamically
// imported behind `import.meta.env.PROD` guards and the `debug` HTML entrypoint is spliced out of
// production builds by the `entrypoints:found` hook in wxt.config.ts. Nothing here ships to prod.
//
// The service worker captures the core's HTTP traffic by wrapping `globalThis.fetch` (the core's
// Ktor JS client funnels every call through one bare `fetch()` — see src/debug/netLog.ts) and
// streams entries to the open debug page. The page also drives the SW through the `debug:*` messages
// below, including "force tick" (`debug:force-tick`) — the SW nudges a cycle, reports the core's raw
// blocking reason (or a host-side reason like not-activated / tracker down), and writes a visible
// command log entry (src/debug/router.ts) — and "refresh config" (`debug:refresh-config`), which forces
// a Firebase Remote Config fetch past its 1h client throttle and reports whether the document changed.

import type { BlockingReason } from '@/core/tracker';
import type { DemandInjection } from '@/debug/demandState';
import type { SimulationState } from '@/debug/simulationState';

/**
 * A network exchange the SW captured from the core's `fetch`. Credentials are scrubbed (`redactSecrets`);
 * identifiers — steamids, device ids, deal ids, ordinary query values — are kept, since the log is local
 * and those are what a session bug is read from. Request headers are included, with a credential header's
 * value DESCRIBED rather than disclosed (see src/debug/netLog.ts) — this whole entry is one click from a
 * JSON export that travels.
 */
export interface NetworkLogEntry {
  category: 'network';
  /** Monotonic sequence, assigned by the SW-side IndexedDB store. */
  seq?: number;
  /** Wall-clock ms, stamped by the SW (owns the clock). */
  ts?: number;
  method: string;
  url: string;
  /** Coarse source bucket derived from the URL host. */
  origin: 'dmarket' | 'steam' | 'other';
  /** HTTP status, or 0 for opaque (`mode:'no-cors'`) / null when the fetch threw before a response. */
  status: number | null;
  /** Whether the response was opaque (`mode:'no-cors'`) — status 0 is expected, not an error. */
  opaque?: boolean;
  durationMs: number;
  /**
   * Headers as sent, except that a CREDENTIAL header's value is a DESCRIPTION (auth scheme + length +
   * a JWT's expiry) — `Authorization: Bearer <redacted 812 chars, exp …>`, never the token.
   */
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  responseBody: string | null;
  /** Network/abort error message when the fetch rejected. */
  error: string | null;
  /**
   * Cookies actually scoped to the request URL (attached SW-side via chrome.cookies). A credential's
   * `value` is a DESCRIPTION (steamid + length + expiry), never the secret; other cookies are as sent.
   */
  cookies?: Array<{ name: string; value: string; httpOnly?: boolean; secure?: boolean }>;
}

/** A note emitted by the debug tooling itself (e.g. "log cleared", "force tick blocked"). */
export interface CommandLogEntry {
  category: 'command';
  seq?: number;
  ts?: number;
  event: string;
  note?: string;
  /** Severity for rendering — 'error'/'warn' surface visibly (e.g. a blocked force tick). */
  level?: 'info' | 'warn' | 'error';
}

/**
 * A lifecycle event the core emitted (its `toWireJson` frame, flattened).
 *
 * The core narrates every nodal point of a cycle — including the ones that produce **no** network traffic
 * at all: a watch pass whose codes all matched the dedup baseline, a history axis that correlated to
 * nothing, a report the backend rejected, a cycle that threw. Without a sink for this stream the session log
 * could only show what went over the wire, so "nothing happened" and "we could not see anything" were the
 * same empty capture — which is exactly how an unreported trade rollback stayed undiagnosable.
 *
 * [fields] holds the frame's remaining primitives, subject to the same rules as every other captured value:
 * credentials scrubbed (`redactSecrets`), identifiers kept. The core guarantees this stream carries no
 * secret (see its `LifecycleEvent` KDoc); nested structures are dropped rather than trusted.
 */
export interface LifecycleLogEntry {
  category: 'lifecycle';
  seq?: number;
  ts?: number;
  /** The event tag, e.g. `WatchSummary` / `HistoryCorrelationMiss` / `CycleFailed`. */
  event: string;
  fields?: Record<string, string | number | boolean | null>;
}

export type LogEntry = NetworkLogEntry | CommandLogEntry | LifecycleLogEntry;

// ---- page -> service worker -----------------------------------------------------------------------

export type DebugRequest =
  | { type: 'debug:describe' }
  | { type: 'debug:get-log' }
  | { type: 'debug:clear-log' }
  | { type: 'debug:force-tick' }
  /**
   * Restart the tracker so a refused proof is attempted again.
   *
   * The core treats a `verified:false` verdict as terminal and latches that transition off — deliberately,
   * because identical proof bytes cannot earn a different verdict, and re-proving would cost one full MPC
   * session per cycle for as long as the deal lives. The latch is an in-memory field on the loop, so it
   * clears only when a NEW loop instance exists, and force tick pointedly does not clear it.
   *
   * That left no way to retry at all — and the console makes it worse: `StatusPanel` polls this router
   * every 1-2s, every message resets the MV3 idle timer, so with the console open the worker never
   * respawns and the latch is permanent for the session. Reloading the whole extension was the only
   * escape. This is that escape, as a button.
   */
  | { type: 'debug:retry-proof' }
  | { type: 'debug:refresh-config' }
  | { type: 'debug:set-endpoints'; apiUrl: string; feUrl: string }
  /** Empty string = clear the override, dropping back to a publish or the core's own default. */
  | { type: 'debug:set-notary'; notaryUrl: string }
  /**
   * Arm/disarm the blocking-state simulations (src/debug/simulate.ts).
   *
   * Applying restarts the tracker: two of the scenarios work by pointing the core's own cookie read at a
   * name nothing has, which is core config, and the config is read when the loop is built. The restart
   * already forces one heartbeat, so the simulated state materialises immediately instead of at the next
   * due tick.
   */
  | { type: 'debug:set-simulation'; state: SimulationState }
  /**
   * Arm/disarm a hand-stamped DMA-280 freshness mark (src/debug/demandState.ts).
   *
   * Unlike `debug:set-simulation` this does NOT restart the tracker: nothing here is core config, it is a
   * rewrite of one heartbeat response, so the next heartbeat carries the mark. It is also not a blocking
   * state and has no reason override — see the header of src/debug/demandState.ts for why it is kept out of
   * the scenario vocabulary entirely.
   */
  | { type: 'debug:set-demand'; state: DemandInjection };

/** Which prover the core resolved. Named once here so the UI cannot spell the union a second time. */
export type ProverKind = 'tlsn' | 'noop';

/** A proof in progress. Named here for the same reason as [ProverKind] — three realms render it. */
export interface ProofProgress {
  /** When the oldest in-flight proof started. The surfaces age it themselves, off their own 1s clock. */
  since: number;
  /** How many proofs are in flight (the core caps them at `NotaryConfig.maxConcurrency`, default 2). */
  count: number;
  /** The prover's current stage, e.g. `MPC_SETUP 10%`, or `null` when it cannot be attributed. */
  stage: string | null;
}

export interface DescribeResult {
  ok: true;
  version: string;
  hasSession: boolean;
  /** chrome.alarms scheduledTime (ms) for the core's self-tick, or null if unscheduled. */
  nextTickAt: number | null;
  /** The two endpoints the tracker is currently running against. */
  apiUrl: string;
  feUrl: string;
  /**
   * The notary WebSocket the core is EFFECTIVELY running against, i.e. whatever `resolveNotaryUrl`
   * resolved (src/config/notaryUrl.ts): the `debug.notaryUrl` override, else a published value, else the
   * build default. `null` only when the operator cleared the override and remote config publishes
   * nothing — the build default alone can no longer leave it unset.
   *
   * It used to report the debug override alone, which made it wrong in both directions: a remote-config
   * notary read as "none", and a debug URL on a runtime that cannot host the prover read as "configured".
   * There IS a remote-config path to this field (`notary.notaryUrl`, validated in src/config/settings.ts);
   * an earlier comment here denied it.
   */
  notaryUrl: string | null;
  /**
   * Which prover the core resolved — the one fact that explains an empty `proofPayload`, and the one thing
   * no surface reported. `'noop'` submits a stub with an empty payload by design, so a backend that
   * enforces proofs rejects every report for that deal until it is cancelled; `'tlsn'` runs the real MPC
   * prover in the offscreen document.
   *
   * Derived from the same inputs as the core's own gate — a notary URL plus a host delegate — so it cannot
   * drift from the core's choice without one of those two changing.
   */
  prover: ProverKind;
  /**
   * What last happened to a proof in this worker, or `null` if no proof frame has arrived yet.
   *
   * [prover] answers "is a real prover configured", which is NOT the same question and was being read as if
   * it were: the header said `prover=tlsn` while the core, having had one proof refused, was attempting
   * none — so there was no `POST /p2p/ext/notary` to find and nothing said so. `ok: false` covers refused,
   * failed and — the case that prompted this — not attempted at all.
   *
   * `at` is what stops the answer being read as an event. This is a REMEMBERED outcome that outlives the
   * cycle it came from, so "proof NOT ATTEMPTED" printed beside a forced tick was taken for something that
   * had just happened — while the frame behind it was minutes old and belonged to a deal the backend had
   * since dropped from tracking. Every surface that shows [text] shows its age with it (see [describeAge]).
   */
  lastProof: { text: string; ok: boolean; at: number } | null;
  /**
   * The proof running RIGHT NOW, or `null` when none is — the present-tense counterpart to [lastProof].
   *
   * A proof takes ~16-17 s, of which ~11 s is MPC pre-processing, and for all of it the console reported the
   * PREVIOUS proof's verdict — the header carried nothing that changed while the work was happening, so
   * "generating a proof" and "wedged inside the wasm" looked identical unless you read the session log. The
   * countdown beside it is no help: the core's alarm is periodic and keeps ticking through a long cycle.
   *
   * Carries `since` rather than a rendered age so the page's own 1s clock ticks it, instead of it jumping in
   * 2s steps with the describe poll — a number that advances every second is the whole signal.
   */
  runningProof: ProofProgress | null;
  /**
   * The core's LIVE blocking reason, read straight off the handle (not the persisted mirror), so the
   * console can show a core-vs-host disagreement instead of hiding it. `null` when the worker has no
   * handle (boot failed).
   */
  blockingReason: BlockingReason | null;
  /**
   * The two Steam ids the wrong-account verdict is computed from — the backend's `linkedSteamId` (as last
   * reported to the host) and the subject of the credential currently in the vault. The console showed the
   * verdict but not its inputs, which is precisely what a wrong-account investigation needs: equal ids with
   * the block up means a stale mirror, different ids means the verdict is doing its job, and a `linked` that
   * is not the account the user believes they own means the DMarket profile itself is linked elsewhere.
   * Public account ids only — never the credential's token.
   */
  linkedSteamId: string | null;
  credentialSteamId: string | null;
  /**
   * The blocking-state simulations this WORKER has in effect — not what is merely persisted, for the same
   * reason [notaryUrl] reports the overrides the tracker was really started with. Every surface that could
   * be mistaken for a real block reads this (the header's `sim:` pill, the cookie traffic-lights, the
   * `tracker.blockingReason` panel's checkboxes).
   */
  simulation: SimulationState;
  /**
   * The hand-stamped freshness mark this WORKER is injecting, for the same reason [simulation] is reported:
   * an operator reading "no demand happened" needs to know whether one was ever being stamped.
   */
  demand: DemandInjection;
}

/**
 * Outcome of a forced tick (`debug:force-tick`). Carries the core's RAW blocking reason rather than a
 * curated union of "interesting" ones: the curated version drifted (a blocked tick could render as a
 * green "tick forced"), and a reason the console doesn't know about must still be visible.
 */
export interface ForceTickResult {
  ok: true;
  /** The core's reason after the awaited cycle. `'NONE'` = nothing blocking. */
  reason: BlockingReason;
  /** Set when the extension itself (not the core) is why no trade cycle runs. */
  blocked?: 'inactive';
}

/** Outcome of a forced Remote Config fetch (`debug:refresh-config`). */
export interface RefreshConfigResult {
  ok: true;
  /** False when the build has no Firebase keys (WXT_FIREBASE_* unset) — no request was made. */
  enabled: boolean;
  /** True when the POST actually completed (the fetch stamp advanced); false = fell back to the cache. */
  fetched: boolean;
  /** True when the cached entries differ from what was cached before the fetch. */
  changed: boolean;
  /** Parameters cached: 1 when the template carries `p2p_tracker_config` (the only one cached), else 0. */
  paramCount: number;
}

export type DebugResponse =
  | DescribeResult
  | { ok: true; entries: LogEntry[] }
  /** Bare acknowledgement (clear-log, set-endpoints). */
  | { ok: true }
  | ForceTickResult
  | RefreshConfigResult
  | { ok: false; error: string };

// ---- service worker -> page (broadcast) -----------------------------------------------------------

export interface LogEntryBroadcast {
  type: 'debug:log-entry';
  entry: LogEntry;
}

/** The chrome.alarms name the core self-drives on (mirrors WebExtAlarmsScheduler.DEFAULT_ALARM_NAME). */
export const TICK_ALARM_NAME = 'dmarket_p2p_tracker_tick';

/** Max entries retained in the SW-side IndexedDB ring buffer. */
export const MAX_LOG_ENTRIES = 1000;

/**
 * Coarse age of a remembered timestamp, for the surfaces that report state rather than events.
 *
 * Lives here, in the SW↔UI contract, because both realms render {@link DescribeResult.lastProof}: the service
 * worker into the session log (one line, once) and the console into a header pill (re-rendered every poll).
 * Two formatters would drift and read as two different facts about the same frame.
 *
 * Coarse on purpose — the question this answers is "is this from the cycle I just ran, or from before?", so
 * seconds matter early and nothing beyond a minute does. A future timestamp (clock adjustment mid-session)
 * clamps to `just now` rather than rendering a negative age.
 */
export function describeAge(at: number, now: number): string {
  const secs = Math.floor((now - at) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

/**
 * One line for a proof in progress: `running 12s · MPC_SETUP 10%`.
 *
 * Beside {@link describeAge} for the same reason it lives here — it renders a field of {@link DescribeResult},
 * and a second copy of the wording in the UI tree would drift from this one. Elapsed seconds are exact, not
 * coarse: the question here is "is it moving?", asked repeatedly over ~17 s, and `just now` answers nothing.
 */
export function describeRunningProof(proof: ProofProgress, now: number): string {
  const secs = Math.max(0, Math.floor((now - proof.since) / 1000));
  const many = proof.count > 1 ? ` (${proof.count} proofs)` : '';
  return `running ${secs}s${many}${proof.stage ? ` · ${proof.stage}` : ''}`;
}

// chrome.storage.local keys holding dev-only endpoint overrides (re-applied by the SW on each boot).
export const API_URL_KEY = 'debug.apiBaseUrl';
export const FE_URL_KEY = 'debug.feUrl';
/**
 * Dev-only notary WebSocket override. ABSENT ⇒ a published `tracker.notary.notaryUrl`, else the build
 * default; EMPTY ⇒ the operator cleared it, which drops the build default but leaves a publish standing,
 * and with no publish falls through to the core's own default. `resolveNotaryUrl`
 * (src/config/notaryUrl.ts) owns that table.
 */
export const NOTARY_URL_KEY = 'debug.notaryUrl';
// Dev-only extra origins the page bridge accepts + pushes to, beyond the two prod dmarket origins.
// Seeded from the FE origin whenever the debug console applies an endpoint (settings-driven, so dev
// FE links are configurable rather than hardcoded). Read by the content-script bridge + the SW push.
export const ALLOWED_ORIGINS_KEY = 'debug.allowedOrigins';

/** A named environment: the FE + API endpoint pair the core talks to. */
interface EnvPreset {
  label: string;
  apiUrl: string;
  feUrl: string;
}

/** A preset only exists when both of its endpoints are configured (in .env — see below). */
const preset = (label: string, apiUrl: string | undefined, feUrl: string | undefined): EnvPreset[] =>
  apiUrl && feUrl ? [{ label, apiUrl, feUrl }] : [];

/**
 * Environment presets for the debug console's prefill buttons. Clicking one fills the FE + API fields
 * (the user then presses "apply & restart"); they are NOT a dropdown, so there is no "custom" entry —
 * the fields themselves are the free-form / custom input.
 *
 * The internal Stage/Dev endpoints come from the gitignored .env (WXT_STAGE_* / WXT_DEV_* — see
 * .env.example), so the repository carries no internal hostnames; without them only Prod appears
 * (the fields still accept any URL by hand).
 */
export const ENVIRONMENTS: ReadonlyArray<EnvPreset> = [
  { label: 'Prod', apiUrl: 'https://api.dmarket.com', feUrl: 'https://dmarket.com/' },
  ...preset('Stage', import.meta.env.WXT_STAGE_API_URL, import.meta.env.WXT_STAGE_FE_URL),
  ...preset('Dev', import.meta.env.WXT_DEV_API_URL, import.meta.env.WXT_DEV_FE_URL),
];

/** Narrow a `chrome.runtime` message to a debug request (service-worker side). */
export function isDebugRequest(message: unknown): message is DebugRequest {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return (
    type === 'debug:describe' ||
    type === 'debug:get-log' ||
    type === 'debug:clear-log' ||
    type === 'debug:force-tick' ||
    type === 'debug:retry-proof' ||
    type === 'debug:refresh-config' ||
    type === 'debug:set-endpoints' ||
    type === 'debug:set-notary' ||
    type === 'debug:set-simulation' ||
    type === 'debug:set-demand'
  );
}
