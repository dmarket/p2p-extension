// The one message the service worker sends to the offscreen document, and its reply.
//
// Kept in its own module because both sides import it and neither should import the other: the SW
// half pulls in the whole tracker, the offscreen half pulls in ~10 MB of WASM.

// Type-only (erased at build), so this module stays free of any runtime dependency on the config layer.
import type { TrackerOverrides } from '@/config/settings';

/** `chrome.runtime` message type for a proof request. Namespaced so no other listener claims it. */
export const NOTARY_PROVE = 'dmarket.notary.prove' as const;

/**
 * The config groups the prover actually reads, as validated remote-config overrides.
 *
 * A `TrackerConfig` instance cannot cross `runtime.sendMessage` — it is a Kotlin object, and the
 * structured-clone algorithm would strip it to a useless bag of mangled fields. So the *overrides* travel
 * (plain JSON) and the offscreen document rebuilds the config through the same seam the service worker
 * used (`buildTrackerConfig`), which is what keeps the two realms on identical values.
 *
 * Exactly the two groups `proveNotaryTransition` documents itself as reading, and no more: sending the
 * whole `TrackerOverrides` would put the marketplace cookie names and Steam endpoint config into a message
 * the prover has no use for.
 */
export type ProverOverrides = Pick<TrackerOverrides, 'notary' | 'game'>;

/**
 * A proof request relayed from the loop.
 *
 * `requestJson` is opaque to us — it is produced and consumed by the core, and deliberately carries no
 * credential (only ids and the public `subjectSteamId`). Both tokens travel as their own fields for that
 * reason: a credential in a JSON blob is how one ends up in a log, one under its own name is visible at
 * every site that handles it.
 *
 * The two are **not** interchangeable, and conflating them would bind proofs to the wrong account:
 *  - `notaryToken` — the live DMarket access token, authenticating this client to the notary service;
 *  - `steamAccessToken` — the Steam JWT authenticating the *proven read* to `api.steampowered.com`, i.e.
 *    the `IEconService` call whose status integer the client reports.
 *
 * Both are resolved by the core on the SW side, because that is where credential refresh is owned. Neither
 * is ever logged: the debug session log records the message *type*, never this object.
 *
 * `config` is load-bearing, not an optimisation: `proveNotaryTransition`'s `config` parameter used to be
 * OPTIONAL, so omitting it compiled and then silently ran the prover on `TrackerConfig.defaults()`, whose
 * `notaryUrl` was then `null` — and `WasmNotaryProver` threw `requires NotaryConfig.notaryUrl` on every
 * proof. Since core `.194` that field defaults to the PRODUCTION notary, so the same omission would no
 * longer fail loudly; it would prove against production from whatever context forgot to pass a config.
 * It shipped that way; the field exists so it cannot again (and the core now requires the argument).
 */
export interface NotaryProveMessage {
  type: typeof NOTARY_PROVE;
  requestJson: string;
  notaryToken: string;
  steamAccessToken: string;
  config: ProverOverrides;
  /**
   * How long the offscreen document lets the prover's driver ignore a liveness ping before treating it as
   * wedged (ms); `0` disables that watch. See `web.notaryStuckAfterMs`.
   *
   * Travels in the message for the same reason `config` does: the document is another realm, and the
   * remote-config overlay is resolved in the service worker. Reading `getSettings()` over there would
   * silently use the COMPILED default and make the published value a fiction — the failure this field's
   * neighbour was added to prevent.
   */
  stuckAfterMs: number;
  /**
   * How many proofs this wasm instance may serve before the document recycles it; `0` never recycles.
   * The DOCUMENT's concern, like `stuckAfterMs` — dropped from {@link ProofPayload} below.
   */
  proofsPerInstance: number;
}

/**
 * Reply. `ok: false` carries a message safe to log — the core redacts before it reaches us.
 *
 * `poisoned` means the failure was a wasm trap or a realm-level error, so the prover instance is unusable and
 * the proving context must be recycled before the next proof. Without it one trap bricked every subsequent
 * proof: observed live as `memory access out of bounds` at ~46 s followed by the same message in 4-10 ms,
 * cycle after cycle, from a worker that was still happily answering out of a dead wasm instance.
 */
export type NotaryProveReply =
  | { ok: true; presentation: string }
  | { ok: false; error: string; poisoned?: boolean };

export const isNotaryProveMessage = (m: unknown): m is NotaryProveMessage =>
  typeof m === 'object' && m !== null && (m as { type?: unknown }).type === NOTARY_PROVE;

/** `chrome.runtime` message type for a narration line from the proving realm. */
export const NOTARY_PHASE = 'dmarket.notary.phase' as const;

/**
 * One phase line from the offscreen document, on its way to the session log.
 *
 * The document is the last realm on this path with no voice in the exported artifact, and it holds two facts
 * nothing else can observe: whether cross-origin isolation is actually in effect (a manifest question), and
 * whether this proof paid for a fresh prover worker or reused a warm one (a ~10 MB wasm fetch plus a rayon
 * start — the difference between a 20 s proof and a fast one). Without them, "the request never arrived",
 * "isolation is off despite the manifest keys", "this one was cold" and "the worker realm died" all present
 * as the same single timeout string, and they call for four different fixes.
 *
 * Primitives only, so it cannot smuggle a payload. Nothing listens in production — `logCommand` lives in
 * `src/debug/`, which is stripped from prod — so the send is a no-op there by construction.
 */
export interface NotaryPhaseMessage {
  type: typeof NOTARY_PHASE;
  note: string;
  level?: 'info' | 'warn' | 'error';
}

export const isNotaryPhaseMessage = (m: unknown): m is NotaryPhaseMessage =>
  typeof m === 'object' &&
  m !== null &&
  (m as { type?: unknown }).type === NOTARY_PHASE &&
  typeof (m as { note?: unknown }).note === 'string';

/**
 * The core's `progressLine` format: `stage <step>[ <pct>%][ — <message>]`, e.g.
 * `stage MPC_SETUP 10% — Setting up MPC with the notary…`.
 *
 * The trailing prose is dropped — it is written for the log line, and the two surfaces that read this want a
 * label. `null` for anything else, because the same trace stream also carries the issuance parameters and the
 * socket lines.
 */
const STAGE_LINE = /^stage (.+?)(?: — .*)?$/;

/**
 * Recover the prover's current stage from one narration line, or `null` when the line is not one.
 *
 * TEXT-PARSED, and not because the stage lacks a structure — the wasm emits a `ProveProgress` OBJECT. The core
 * flattens it with `progressLine` before it crosses into JS, and its published callback is
 * `onProgress?: (line: string) => void`, so the object never leaves Kotlin. Plumbing it through would be a
 * change to `@dmarket/p2p-tracker-core`, a snapshot publish and a dependency bump — too much for a dev-console
 * label. A line that stops matching degrades to "no stage", never to a throw.
 *
 * Shared because BOTH realms need it and neither can import the other's copy: the prover worker annotates its
 * own socket ticks with the live stage, and the service worker reads the same lines off the relay for the
 * console. This module is where they meet — it is the seam contract, and it stays free of runtime deps.
 */
export const parseStageLine = (line: string): string | null => STAGE_LINE.exec(line)?.[1] ?? null;

// ---- offscreen document <-> prover worker ---------------------------------------------------------
//
// The third leg of the same seam. It lives here rather than in `prover-worker.ts` for a build reason that
// is easy to undo by accident: the worker module statically imports the core, so a RUNTIME import from it
// (a type guard, say) pulls ~1.2 MB of wasm glue back into the offscreen document's own chunk — measured,
// 1.4 kB → 1.23 MB. The document must only ever `import type` from the worker.

/**
 * What the worker needs to produce one proof: the message minus its envelope.
 *
 * `stuckAfterMs` and `proofsPerInstance` are dropped along with `type` — both configure the DOCUMENT, and the worker is
 * the thing being watched. Handing it its own supervision threshold would be both useless (a blocked thread
 * cannot act on it) and misleading.
 */
export type ProofPayload = Omit<NotaryProveMessage, 'type' | 'stuckAfterMs' | 'proofsPerInstance'>;

/** One proof request, correlated so one worker can serve concurrent proofs. */
export interface ProverWorkerRequest {
  id: number;
  proof: ProofPayload;
}

/** A finished proof, reusing the seam's own result shape so there is one definition of "a proof outcome". */
export interface ProverWorkerReply {
  id: number;
  reply: NotaryProveReply;
}

/** A narration line on its way out of the worker realm — the only way anything there reaches the log. */
export interface ProverWorkerTrace {
  trace: string;
  level?: 'info' | 'warn' | 'error';
}

/**
 * A liveness probe, and the answer to one.
 *
 * The failure this exists for: the prover's driver blocks its thread on `Atomics.wait` (see the header of
 * `entrypoints/offscreen/prover-worker.ts`), and a blocked thread runs no timers, no socket callbacks and no
 * message handlers. Observed live on 2026-08-25 — a proof pushed 39 MB to the notary, took the target's
 * response, and then emitted **nothing at all for 170 s** until the service worker's 180 s deadline killed it.
 * From outside, that is indistinguishable from an MPC session that is merely slow.
 *
 * A pong cannot be faked by a wedged realm, because answering one requires the very thread that is stuck. So
 * the document pings while a proof is in flight and treats a sustained silence as a wedge, which turns three
 * minutes of a blocked tracker cycle into ~25 s. The probe carries a sequence number only: it is a heartbeat,
 * and anything else on it would be a payload crossing a boundary for no reason.
 */
export interface ProverWorkerPing {
  ping: number;
}

export interface ProverWorkerPong {
  pong: number;
}

/** What the document may send the worker. */
export type ProverWorkerInbound = ProverWorkerRequest | ProverWorkerPing;

export type ProverWorkerMessage = ProverWorkerReply | ProverWorkerTrace | ProverWorkerPong;

export const isProverWorkerTrace = (m: ProverWorkerMessage): m is ProverWorkerTrace =>
  typeof (m as ProverWorkerTrace).trace === 'string';

export const isProverWorkerPong = (m: ProverWorkerMessage): m is ProverWorkerPong =>
  typeof (m as ProverWorkerPong).pong === 'number';

export const isProverWorkerPing = (m: ProverWorkerInbound): m is ProverWorkerPing =>
  typeof (m as ProverWorkerPing).ping === 'number';
