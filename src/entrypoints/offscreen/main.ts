// The offscreen document: the only context in this extension that can run the TLSN prover.
//
// Why not the service worker, where the tracker loop lives: the prover's rayon pool calls
// `new Worker(…)`, which `ServiceWorkerGlobalScope` does not expose, and Chrome documents
// cross-origin isolation as "not fully implemented" for service workers. Both are hard blocks, so the
// loop delegates here and this file does nothing but run the core's proof entry point.
//
// The WASM module and its `SharedArrayBuffer` are created and stay inside this document. That is not
// only cleaner, it is required: a `SharedArrayBuffer` cannot be reliably passed from a service worker
// to an offscreen document, so nothing attempts it.
//
// Requires cross-origin isolation (manifest COEP/COOP keys) — asserted below, because without it the
// failure is a confusing mid-proof error rather than an obvious one.
//
// This document does NOT run the prover itself; it owns the isolation and forwards to a dedicated worker that
// does (see ./prover-worker.ts). Driving the prover from here blocks the document's main thread, which the
// platform refuses outright: `Atomics.wait cannot be called in this context`.

import {
  isNotaryProveMessage,
  isProverWorkerPong,
  isProverWorkerTrace,
  NOTARY_PHASE,
  type NotaryPhaseMessage,
  type NotaryProveReply,
  type NotaryProveMessage,
  type ProverWorkerMessage,
  type ProverWorkerPing,
  type ProverWorkerRequest,
} from '@/core/notary-messages';

if (!self.crossOriginIsolated) {
  // Not thrown: the document must stay alive so the SW's message still gets a legible reply rather
  // than a silent port closure.
  console.error(
    '[notary] offscreen document is NOT cross-origin isolated — the prover needs SharedArrayBuffer. ' +
      'Check the cross_origin_embedder_policy / cross_origin_opener_policy manifest keys.',
  );
}

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isNotaryProveMessage(message)) return undefined;

  void runProof(message).then(sendResponse);
  // `true` keeps the message channel open for the async reply. A proof takes seconds (MPC), so this is
  // load-bearing — returning undefined here would close the port before the presentation exists.
  return true;
});

/**
 * Breadcrumbs for the one code path in this extension that is otherwise completely unobservable.
 *
 * `netLog` wraps `globalThis.fetch` in the service worker, and this is a separate realm — so the ~10 MB wasm
 * fetch, both notary/proxy WebSockets and the MPC session leave no trace in the session log. When a proof hung,
 * the log showed a cycle that reported and then emitted nothing at all, and there was no way to tell whether
 * the message had even arrived here.
 *
 * Two lines per proof, kept out of the dev-only guard on purpose: this path has never yet produced a proof, so
 * the cost of a console line is not worth the cost of another silent failure. They name no credential — the
 * ids come from the request JSON, which is credential-free by construction.
 *
 * Also relayed to the service worker, which is the only context that can put them in the EXPORTED session log
 * — a console line helps whoever is at the keyboard, and nobody else. The send is best-effort and no-ops in
 * production, where nothing is listening (the ingest lives in the dev-only debug router).
 */
const phase = (msg: string, level?: NotaryPhaseMessage['level']): void => {
  console.info(`[notary] ${msg}`);
  try {
    const relay: NotaryPhaseMessage = { type: NOTARY_PHASE, note: msg, level };
    void browser.runtime.sendMessage(relay).catch(() => {});
  } catch {
    /* no receiver */
  }
};

async function runProof(message: NotaryProveMessage): Promise<NotaryProveReply> {
  const startedAt = Date.now();
  // Which prover config actually crossed the boundary — the fact that took two rounds of log-reading to
  // establish, and the one a stale remote-config document silently changes — plus the two facts only this
  // realm can report. `worker` is read BEFORE `runInWorker` creates one: a reused DOCUMENT can still hold a
  // freshly created worker, because any realm error clears the handle (see `proverWorker`), so "the document
  // was already open" is not a substitute for knowing whether this proof paid the ~10 MB wasm load.
  //
  // Since the post-proof recycle landed, `worker=reused` no longer means "warm from an earlier proof" — it
  // means this proof JOINED one still in flight, and is therefore the only shape in which two proofs share a
  // wasm instance at all. Worth reading as such if a wedge ever recurs.
  // `notaryUrl` alone was not enough, and a live regression proved it: a proof died
  // `invalid peer certificate: UnknownIssuer` on a substrate whose fixture CA was verifiably in `.env` AND in
  // the built `background.js` — so the open question was whether the PEM crossed THIS boundary, and nothing
  // could answer it. Three additions, each ruling out a whole class:
  //  - `rootStorePem`, which is half of a package: a fixture PEM REPLACES the Mozilla set (`RootStore` is
  //    `"mozilla" | {pem}`), so a fixture root reached through the production proxy — i.e. the real
  //    api.steampowered.com — fails exactly the same way as no PEM at all against a fixture target. The
  //    verdict is in the PAIRING, never in either half, and the other half is the proxy. This line used to
  //    carry it, and that is how the stale published `proxyBaseUrl` was finally caught — but the field is no
  //    longer settable from anywhere (see NOTARY_SCHEMA), so printing it here would be a constant dressed as
  //    a finding. The EFFECTIVE proxy is in the core's own `issuance` breadcrumb, which reads the built
  //    config rather than the overrides, and is therefore the half to read against this one.
  //  - `dev`, because the PEM is injected under `import.meta.env.DEV` in background.ts. A substrate built with
  //    `npm run build` instead of `build:debug` has no fixture root at all, and every other clue looks fine.
  // The PEM's LENGTH, never its bytes — it is public, but it is multi-kilobyte and would bury the log.
  const notary = message.config.notary;
  phase(
    `proof requested: notaryUrl=${notary?.notaryUrl ?? '(none)'} ` +
      `rootStorePem=${notary?.rootStorePem ? `${notary.rootStorePem.length} chars` : 'absent → mozilla roots'} ` +
      `dev=${import.meta.env.DEV} isolated=${self.crossOriginIsolated} worker=${worker ? 'reused' : 'created'}`,
  );
  const reply = await runInWorker(message);
  phase(
    reply.ok
      ? `proof produced in ${Date.now() - startedAt}ms (${reply.presentation.length} base64 chars)`
      : `proof failed after ${Date.now() - startedAt}ms: ${reply.error}`,
    reply.ok ? 'info' : 'error',
  );
  // A trapped wasm instance cannot be re-entered, and the façade memoises instantiation — so a worker that
  // has trapped will answer every later proof with the same error in milliseconds. Discard it here rather
  // than leaving the service worker to infer it: the next proof pays one ~10 MB load and actually runs.
  //
  // Unconditional, unlike the routine recycle below: a dead instance cannot serve the proofs still waiting on
  // it either, and `discardWorker` answers them.
  if (!reply.ok && reply.poisoned) {
    discardWorker('the prover instance trapped and cannot be re-entered');
    return reply;
  }
  // RECYCLE EVERY N PROOFS, not every one. The instance and its rayon pool are process-wide inside this realm
  // and upstream does warn about reusing them (tlsn #959, "re-init every 5 proofs"), so the hygiene is real —
  // but the interval was 1, and that 1 rested on a single sample.
  //
  // The sample: on 2026-08-25 the SECOND proof in a warm realm froze for the full 180 s deadline while the
  // next attempt on a fresh realm verified in 15.8 s. Its own comment conceded that one sample cannot prove
  // reuse was the cause. It was not: across 22 attempts on 2026-08-26 the wedge hit `worker=created` as
  // readily as `worker=reused`, and the single variable separating every success from every failure was
  // whether the target socket delivered its upstream close — nothing to do with instance age.
  //
  // The cost, by contrast, is paid every attempt: a ~10 MB wasm fetch + compile and a fresh rayon pool. On a
  // machine tracking 10 proof-required deals that is continuous, and MPC setup there measured 11-44 s against
  // ~5 s on a lightly loaded one — so the load this creates is now itself a suspect for the wedge, which
  // makes paying it five times over the wrong trade in both directions.
  //
  // `web.notaryProofsPerInstance` is remote-settable: publish `1` to restore the old behaviour without a
  // release, `0` to never recycle.
  //
  // Only when nothing else is in flight: `maxConcurrency` proofs share this realm, and terminating it under a
  // live proof would fail it for no reason. The last of a concurrent batch to finish does the recycling.
  servedByWorker += 1;
  if (waiting.size === 0 && proofsPerInstance > 0 && servedByWorker >= proofsPerInstance) {
    discardWorker(`routine recycle — ${servedByWorker} proofs served by this wasm instance`, 'info');
  }
  return reply;
}

/**
 * One worker per N proofs — created on demand, discarded once the last proof of an interval has answered.
 *
 * The ~10 MB wasm fetch and compile is memoised per realm, so the interval decides how often it is re-paid.
 * It was 1, on the reasoning in {@link runProof}'s recycle; it is now `web.notaryProofsPerInstance` (5),
 * matching upstream's "re-init every 5 proofs" (tlsn #959) without paying for it on every attempt.
 *
 * Requests are still correlated by id, because the core allows `maxConcurrency` proofs in flight and they do
 * share one realm; the recycle waits for the last of them.
 */
let worker: Worker | undefined;
let nextId = 1;

/**
 * Proofs the CURRENT wasm instance has served, and the interval it is recycled at.
 *
 * The count resets with the instance (in {@link discardWorker}), never on a proof — so a trap or a wedge
 * mid-interval starts the next instance's tally from zero rather than recycling it early.
 */
let servedByWorker = 0;
let proofsPerInstance = 1;
const waiting = new Map<number, (reply: NotaryProveReply) => void>();

function proverWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./prover-worker.ts', import.meta.url), { type: 'module' });
  w.addEventListener('message', (e: MessageEvent<ProverWorkerMessage>) => {
    // Narration, not a result: the worker's WebSocket trace and its own breadcrumbs come this way, because
    // it is not an extension context and cannot reach the service worker itself.
    if (isProverWorkerTrace(e.data)) {
      phase(e.data.trace, e.data.level);
      return;
    }
    // The liveness answer. Only its ARRIVAL carries information — see `startLivenessWatch`.
    if (isProverWorkerPong(e.data)) {
      lastPongAt = Date.now();
      return;
    }
    const settle = waiting.get(e.data.id);
    if (!settle) return;
    waiting.delete(e.data.id);
    settle(e.data.reply);
  });
  // A worker that dies takes every in-flight proof with it; answer them rather than leaving the caller waiting
  // — the failure mode this whole seam has been fighting.
  w.addEventListener('error', (e) => {
    phase(`prover worker errored: ${e.message}`, 'error');
    worker = undefined;
    servedByWorker = 0;
    stopLivenessWatch();
    for (const [id, settle] of [...waiting]) {
      waiting.delete(id);
      settle({ ok: false, error: `prover worker errored: ${e.message}`, poisoned: true });
    }
  });
  worker = w;
  return w;
}

/**
 * Terminate the current worker so the next proof gets a fresh wasm instance.
 *
 * `terminate()` rather than dropping the reference: the rayon pool holds live threads, and an abandoned
 * worker would keep them (and its ~10 MB of wasm) alive for the document's lifetime. Any proof still waiting
 * is answered — it can never be, now that the realm is gone.
 *
 * @param why Reason for the recycle, in the log line and in the error every waiting proof is answered with.
 * @param level `warn` for the failure paths, `info` for the routine post-proof recycle. Not cosmetic: this is
 *   now the most frequent line on the path, and logging every healthy proof's recycle as a warning is how a
 *   log stops being read.
 */
function discardWorker(why: string, level: NotaryPhaseMessage['level'] = 'warn'): void {
  if (!worker) return;
  phase(`discarding the prover worker: ${why}`, level);
  worker.terminate();
  worker = undefined;
  servedByWorker = 0;
  stopLivenessWatch();
  for (const [id, settle] of [...waiting]) {
    waiting.delete(id);
    settle({ ok: false, error: `prover worker discarded: ${why}`, poisoned: true });
  }
}

/**
 * How often the document probes the worker while a proof is in flight.
 *
 * Fixed, unlike the silence threshold it feeds (`web.notaryStuckAfterMs`, which arrives per proof): probing
 * more often only sharpens the measurement, so this is not the value a misfire would need to change.
 */
const LIVENESS_PING_EVERY_MS = 5_000;

let liveness: ReturnType<typeof setInterval> | undefined;
let lastPongAt = 0;
let pingSeq = 0;
/** The live threshold, from the message of the most recent proof; `0` means the watch is off. */
let stuckAfterMs = 0;

/**
 * Watch the prover's driver for the one failure that produces no error, no rejection and no log line.
 *
 * The driver blocks its own thread on `Atomics.wait`, and a blocked thread runs no timers, no socket callbacks
 * and no message handlers — so a wedged prover is silent in every channel that could report it. That silence
 * is also what makes a probe sound: answering a ping needs the stuck thread, so a pong cannot be produced by a
 * realm that is stuck. Nothing here interprets the pong's value.
 *
 * Runs in the DOCUMENT, whose main thread the prover never blocks (it cannot — `Atomics.wait` is refused
 * there, which is why the worker exists at all). Only while a proof is in flight: with none, a quiet worker is
 * just idle.
 *
 * @param threshold ms of unanswered probing that counts as wedged, or `0` to not watch at all — the kill
 *   switch for a threshold that turns out to misfire. Comes from the proof message, i.e. from remote config.
 */
function startLivenessWatch(threshold: number): void {
  stuckAfterMs = threshold;
  if (threshold <= 0 || liveness !== undefined) return;
  lastPongAt = Date.now();
  liveness = setInterval(() => {
    const w = worker;
    if (!w || waiting.size === 0 || stuckAfterMs <= 0) {
      stopLivenessWatch();
      return;
    }
    const silentFor = Date.now() - lastPongAt;
    if (silentFor >= stuckAfterMs) {
      // Discarding is what makes this actionable rather than merely observable: the in-flight proofs are
      // answered as poisoned, so the service worker fails them NOW instead of at its deadline, and the core
      // turns that into `ProofFailed` → the transition is re-detected and retried on the next tick with a
      // fresh realm. The 180 s deadline stays as the outer backstop for the failures this cannot see (a
      // document that never came up, a `sendMessage` that never settles).
      discardWorker(`the prover driver answered no liveness ping for ${silentFor}ms — wedged inside the wasm`);
      return;
    }
    w.postMessage({ ping: ++pingSeq } satisfies ProverWorkerPing);
  }, LIVENESS_PING_EVERY_MS);
}

function stopLivenessWatch(): void {
  if (liveness !== undefined) clearInterval(liveness);
  liveness = undefined;
}

function runInWorker(message: NotaryProveMessage): Promise<NotaryProveReply> {
  const id = nextId++;
  const { requestJson, notaryToken, steamAccessToken, config } = message;
  const request: ProverWorkerRequest = { id, proof: { requestJson, notaryToken, steamAccessToken, config } };
  return new Promise<NotaryProveReply>((resolve) => {
    waiting.set(id, resolve);
    proverWorker().postMessage(request);
    // After the post, not before: the watch only means anything once there is a proof to be wedged on, and
    // `proverWorker()` is what creates the realm being watched.
    proofsPerInstance = message.proofsPerInstance;
    startLivenessWatch(message.stuckAfterMs);
  });
}
