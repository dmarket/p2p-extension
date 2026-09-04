// The dedicated worker that actually runs the TLSN prover.
//
// WHY THIS FILE EXISTS — and it is not the reason the offscreen document exists. That one is about
// `SharedArrayBuffer` and cross-origin isolation, which a service worker cannot have. This one is about who is
// allowed to *block*:
//
//   RuntimeError: Atomics.wait cannot be called in this context
//
// `Atomics.wait` is rejected in any agent whose `[[CanBlock]]` is false — which is the main thread of every
// Window/Document, the offscreen document included. A dedicated worker's `[[CanBlock]]` is true. The prover's
// rayon pool spawns its own workers to do the work, but the *driver* — whoever calls in and waits for them —
// blocks, so the driver cannot be the document's main thread. We knew workers were needed for the pool; the
// constraint is on the caller.
//
// Cross-origin isolation is inherited from the embedding document, so `SharedArrayBuffer` is still available
// here, and the manifest's `worker-src 'self'` already permits this worker.
//
// Upstream has never executed this path: `client-wasm/RUN_E2E.md` records the live run as deferred, so nothing
// there documents the constraint.

import { proveNotaryTransition } from '@dmarket/p2p-tracker-core';
import { buildTrackerConfig } from '@/core/config';
import { isProverWorkerPing, parseStageLine } from '@/core/notary-messages';
import type {
  NotaryProveReply,
  ProofPayload,
  ProverWorkerInbound,
  ProverWorkerPong,
  ProverWorkerReply,
  ProverWorkerTrace,
} from '@/core/notary-messages';

const trace = (line: string, level?: ProverWorkerTrace['level']): void => {
  console.info(`[notary/worker] ${line}`);
  self.postMessage({ trace: line, level } satisfies ProverWorkerTrace);
};

/**
 * How often each open socket reports its byte counters. 5s over a 180s deadline is ~36 lines per socket for a
 * proof that overruns, and a handful for one that does not — cheap next to being unable to tell a slow MPC
 * from a wedged one.
 */
const PROGRESS_EVERY_MS = 5_000;

/**
 * How long a socket may carry nothing before a progress tick is flagged.
 *
 * A heuristic for reading the log, not a timeout — nothing acts on it. Chosen against measurements: a healthy
 * proof completed its whole Steam exchange within ~14 s of the target socket opening, while a failing one sat
 * at exactly zero bytes for ~21 s before the upstream dropped it. So the first few quiet ticks are the normal
 * preprocessing window and only a longer silence distinguishes the two.
 */
const IDLE_WARN_MS = 15_000;

/**
 * The stage the prover last reported, and when it entered it.
 *
 * A `PROGRESS` line used to be byte counters and nothing else, which is the same shape whether the MPC is
 * pre-processing or the notary has stopped answering. Measured live on dev 2026-08-28: a healthy proof spends
 * 10.8 s of its 17.4 s inside `MPC_SETUP`, pushing ~38 MB, and the only thing naming that stage was a single
 * line 10 s further up the log. Naming it ON the tick is what makes the tick self-contained.
 *
 * Written by the core's progress callback in {@link run}, read by the socket ticks — see {@link stageNote}
 * for why it is only reported while exactly one proof is running.
 */
let stage: { name: string; since: number } | undefined;

function noteStage(line: string): void {
  const step = parseStageLine(line);
  if (step) stage = { name: step, since: Date.now() };
}

/**
 * ` · MPC_SETUP 10% for 7.2s`, or empty when no stage can be attributed to this socket.
 *
 * The guard is `pending.size`: the core runs up to `NotaryConfig.maxConcurrency` proofs at once, and neither
 * the stage lines nor the sockets carry a proof id — so with two in flight, pinning one stage to one socket
 * would be a guess printed on the line a wedge is diagnosed from. `runningProof` in src/debug/proofState.ts
 * applies the same rule to the console pill, against that realm's own count.
 */
function stageNote(): string {
  if (!stage || pending.size !== 1) return '';
  return ` · ${stage.name} for ${((Date.now() - stage.since) / 1000).toFixed(1)}s`;
}

/**
 * Narrate the prover's WebSockets.
 *
 * These are the ONLY thing the proof path does on the wire, and nothing could see them: `netLog` wraps
 * `globalThis.fetch` in the service worker, this is a different realm, and they are not fetches anyway. So
 * "the proof timed out" carried no information about whether the notary was even reached — which is exactly
 * the question that has been unanswerable for three rounds of debugging.
 *
 * NEVER log the second constructor argument. `transport`'s notary socket passes the live DMarket access token
 * as a WebSocket SUBPROTOCOL (`bearer.<token>`), so the protocols array is a credential. Only the URL is
 * traced, and the proxy's URL carries just `?host=…&port=…`.
 *
 * Per-frame logging is deliberately absent: an MPC session is tens of thousands of frames. Open, periodic
 * progress, close (with the code and the byte totals) and error is what distinguishes "never connected",
 * "connected and the peer hung up", "connected, exchanged N bytes, then we trapped" — and, since the progress
 * ticks, "still moving bytes, just not fast enough".
 */
function traceWebSockets(): void {
  const Native = self.WebSocket;
  if (typeof Native !== 'function') return;
  let n = 0;
  const Traced = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const id = ++n;
    const sock = new Native(url, protocols);
    const where = ((): string => {
      try {
        const u = new URL(String(url));
        // Query kept for the proxy's host/port, which is the routing fact worth seeing; it holds no secret.
        return `${u.origin}${u.pathname}${u.search}`;
      } catch {
        return '(unparseable url)';
      }
    })();
    let sent = 0;
    let recv = 0;
    let openedAt = 0;
    // When bytes last moved in either direction, so a progress tick can tell "quiet for a moment" from
    // "quiet for a worryingly long time". Seeded at open, not at 0, so the first window is measured from
    // when the socket actually became usable.
    let lastMovedAt = 0;
    // FIRST byte each way, with the delay since the socket opened. The totals on close were not enough: a
    // proxy socket that carried `sent 0B recv 0B` for 21 s before the upstream dropped it says the MPC never
    // wrote, but not whether the NOTARY leg was making progress meanwhile — which is the difference between
    // "preprocessing is too slow" and "the notary handshake stalled". One line per direction per socket.
    const firstByte = (dir: 'send' | 'recv', n: number): void => {
      trace(`ws#${id} first ${dir} after ${openedAt ? Date.now() - openedAt : 0}ms (${n}B) ${where}`);
    };
    // Progress WHILE the session runs, not only its totals once it ends. Between `first send` and a deadline
    // kill this path emitted NOTHING, so "the MPC is uploading 63 MB at 1 MB/s" and "the MPC is wedged"
    // produced byte-for-byte identical logs — three rounds of 60s timeouts that could not be told apart. The
    // zero-delta ticks are the point, not noise: they are the only positive evidence of a stall.
    //
    // A GAP in these lines is signal of a third kind. The prover's driver blocks this thread on `Atomics.wait`
    // (see the file header), and a blocked thread does not run timers — so ticks that never fire say the
    // driver is stuck inside the wasm, not that the wire went quiet.
    let progress: ReturnType<typeof setInterval> | undefined;
    let tickSent = 0;
    let tickRecv = 0;
    const stopProgress = (): void => {
      if (progress !== undefined) clearInterval(progress);
      progress = undefined;
    };
    const send = sock.send.bind(sock);
    sock.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView): void => {
      const n = byteLength(data);
      if (sent === 0) firstByte('send', n);
      sent += n;
      send(data);
    };
    sock.addEventListener('message', (e) => {
      const n = byteLength(e.data as never);
      if (recv === 0) firstByte('recv', n);
      recv += n;
    });
    sock.addEventListener('open', () => {
      openedAt = Date.now();
      lastMovedAt = openedAt;
      trace(`ws#${id} OPEN ${where} (subprotocol ${sock.protocol || 'none'})`);
      progress = setInterval(() => {
        const dSent = sent - tickSent;
        const dRecv = recv - tickRecv;
        tickSent = sent;
        tickRecv = recv;
        const moved = dSent !== 0 || dRecv !== 0;
        if (moved) lastMovedAt = Date.now();
        const idleMs = Date.now() - lastMovedAt;
        trace(
          `ws#${id} PROGRESS ${((Date.now() - openedAt) / 1000).toFixed(1)}s ` +
            `sent ${bytes(sent)} (+${bytes(dSent)}) recv ${bytes(recv)} (+${bytes(dRecv)}) ${where}` +
            stageNote(),
          // Only a SUSTAINED silence is worth flagging. This used to warn on the first quiet tick, which made
          // the normal case red: the target socket is opened before the MPC has finished preprocessing, so it
          // is legitimately silent for the first several seconds while the notary leg does the work. A
          // display hint, not a verdict — see IDLE_WARN_MS.
          idleMs >= IDLE_WARN_MS ? 'warn' : 'info',
        );
      }, PROGRESS_EVERY_MS);
    });
    sock.addEventListener('error', () => {
      stopProgress();
      trace(`ws#${id} ERROR ${where} — sent ${sent}B recv ${recv}B`, 'error');
    });
    sock.addEventListener('close', (e) => {
      // Before the trace, not after: a socket the offscreen document outlives would otherwise keep ticking on
      // a dead session, and this worker is reused for every proof until the document is recycled.
      stopProgress();
      const { code, reason, wasClean } = e;
      trace(
        `ws#${id} CLOSE ${where} code=${code}${reason ? ` reason=${reason}` : ''} clean=${wasClean} — sent ${sent}B recv ${recv}B`,
        // Keyed on `wasClean`, NOT on the code. This used to warn on anything but 1000, which made the
        // ordinary end of a healthy session red: **1005 is "No Status Received"**, i.e. the peer closed
        // without sending a status code, and the browser still reports `wasClean: true`. 1006 is the one that
        // means something went wrong, and it comes with `wasClean: false`.
        wasClean ? 'info' : 'warn',
      );
    });
    trace(`ws#${id} CONNECTING ${where}`);
    return sock;
  } as unknown as typeof WebSocket;
  // Statics the glue may read off the constructor (CONNECTING/OPEN/CLOSING/CLOSED).
  Object.setPrototypeOf(Traced, Native);
  Traced.prototype = Native.prototype;
  self.WebSocket = Traced;
}

/**
 * Human-scaled byte counts for the progress lines only — the CLOSE totals stay exact.
 *
 * An MPC session spans five orders of magnitude on one socket (a 14 B hello, then tens of MB of
 * preprocessing), and `63402478B` is not a number anyone reads a rate off at a glance.
 */
function bytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function byteLength(data: string | ArrayBufferLike | ArrayBufferView | Blob): number {
  if (typeof data === 'string') return data.length;
  if (data instanceof Blob) return data.size;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}
traceWebSockets();

/**
 * The core resolves the prover's own assets as `chrome.runtime.getURL('pkg/…')`, and a dedicated worker is not
 * an extension context — it has neither `browser` nor `chrome`. Everything it needs is derivable from its own
 * location, since the worker script is itself served from the extension origin.
 *
 * Only fills what is missing: if a future Chrome does expose the real API here, that one is authoritative.
 */
function shimExtensionApi(): void {
  const g = globalThis as unknown as { chrome?: { runtime?: { getURL?: (p: string) => string } } };
  if (g.chrome?.runtime?.getURL) return;
  const getURL = (path: string): string => new URL(path.replace(/^\/+/, ''), `${self.location.origin}/`).href;
  g.chrome = { ...g.chrome, runtime: { ...g.chrome?.runtime, getURL } };
}
shimExtensionApi();

/** Requests still in flight, so a failure that escapes a single proof can still be attributed. */
const pending = new Set<number>();

const post = (message: ProverWorkerReply): void => {
  pending.delete(message.id);
  self.postMessage(message);
};

/**
 * Fail every in-flight proof when the realm itself breaks.
 *
 * This is the half that turned a crash into a hang. The `Atomics.wait` error surfaced as
 * `Uncaught (in promise)` from inside the wasm glue — a promise nobody holds — so it never reached the
 * `await` in `runProof` and the caller waited forever. Here it becomes a reply.
 */
const failAll = (reason: string): void => {
  // Realm-level: whatever broke did so outside any one proof, so the wasm instance cannot be trusted.
  for (const id of [...pending]) post({ id, reply: { ok: false, error: reason, poisoned: true } });
};

self.addEventListener('unhandledrejection', (e) => {
  // `reason` is typed `any`; annotate it away at the boundary so nothing downstream inherits that.
  const r: unknown = e.reason;
  failAll(`prover realm rejected: ${describeFailure(r)}`);
});
self.addEventListener('error', (e) => {
  failAll(`prover realm errored: ${e.message}`);
});

/**
 * Messages that mean the wasm instance is DEAD rather than that this one proof failed.
 *
 * A wasm trap unwinds the whole linear memory into an undefined state; the module cannot be re-entered.
 * Observed live: one `memory access out of bounds` at ~46 s, and then every later proof failing in 4-10 ms
 * with the same message — the worker was serving requests from a corpse. A clean failure (a refused notary
 * handshake, a config `require`) leaves the instance usable, which is why this is a match rather than
 * "recycle on any error": the alternative re-fetches and re-compiles ~10 MB every ~90 s while a notary is
 * merely down.
 */
const WASM_TRAP =
  /memory access out of bounds|unreachable|table index is out of bounds|null function|RuntimeError|out of memory|indirect call/i;

/** The message plus, for a trap, the frames — the caller only ever receives a string. */
function describeFailure(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  // Frames only for a trap: this is the one failure whose location we cannot otherwise learn, because the
  // stack exists only in this realm and the offscreen console is not in the exported session log.
  if (!WASM_TRAP.test(e.message) || !e.stack) return e.message;
  const frames = e.stack.split('\n').slice(1, 5).map((l) => l.trim()).join(' | ');
  return `${e.message} @ ${frames}`;
}

self.addEventListener('message', (event: MessageEvent<ProverWorkerInbound>) => {
  // Answered first and answered cheaply. The value of the pong is not its content but the fact that this
  // handler ran at all: the driver blocks THIS thread, so a wedged prover cannot produce one. Not traced —
  // one line every few seconds per proof would bury the traces that matter, and the document already narrates
  // the only interesting outcome (a silence long enough to act on).
  if (isProverWorkerPing(event.data)) {
    self.postMessage({ pong: event.data.ping } satisfies ProverWorkerPong);
    return;
  }
  const { id, proof } = event.data;
  pending.add(id);
  void run(proof).then((reply) => post({ id, reply }));
});

async function run(proof: ProofPayload): Promise<NotaryProveReply> {
  // Cleared per proof, so a tick early in this one cannot carry the last one's final stage.
  stage = undefined;
  try {
    // The Steam token's LENGTH, never its value — the same practice `describeSecret` follows for headers and
    // cookies in the session log.
    //
    // It is the only unknown in the proven request's size, and therefore the only unknown in whether
    // `NotaryConfig.maxSentData` is set anywhere near what the read needs. `max_sent_data` bounds the
    // PLAINTEXT transcript sent to the target and sizes the MPC pre-processing with it (`client-core`'s
    // `IssuanceConfig` calls it exactly that), so an over-large bound is paid for in megabytes uploaded to the
    // notary — one session was measured at 63 MB. Everything else in that request is fixed and countable from
    // the template: 196 bytes on the larger (history) axis, request line and four injected headers included.
    // This line closes the gap, because the log's URL scrubbing removes the query value AND its length.
    trace(`steam token ${proof.steamAccessToken.length} chars → proven request ≈ ${196 + proof.steamAccessToken.length}B sent`);
    const config = buildTrackerConfig(undefined, proof.config);
    const presentation = await proveNotaryTransition(
      proof.requestJson,
      proof.notaryToken,
      proof.steamAccessToken,
      config as Parameters<typeof proveNotaryTransition>[3],
      // The proving realm's own trace: the issuance parameters it actually resolved, then the wasm's stage
      // boundaries. Neither is observable from out here — a host log can only report what it SENT, and a
      // wedge stops the stage lines dead, so the LAST one before a silence names the stage that hung. On
      // 2026-08-25 the socket traces proved only that 39 MB had moved and the response had arrived, which
      // left "died in the disclosure step", "died in the phase-2 attestation exchange" and "waiting on a
      // rayon thread" indistinguishable. Cheap: a handful of lines per proof.
      (line) => {
        // Also the socket ticks' only source of "which stage is this" — see `stage` above.
        noteStage(line);
        trace(line);
      },
    );
    return { ok: true, presentation };
  } catch (e) {
    // Logged whole (stack included) because this realm's console is the only place a full stack exists.
    // Safe: the request carries ids only, and neither token is part of it.
    console.error('[notary/worker] proof failed', e);
    const error = describeFailure(e);
    // A trap that was CAUGHT here is still a trap — the instance is just as dead as one that escaped.
    return { ok: false, error, poisoned: e instanceof Error && WASM_TRAP.test(e.message) };
  }
}
