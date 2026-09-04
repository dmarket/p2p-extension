// Service-worker half of the notary seam: hand the core's proof request to the offscreen document.
//
// The core cannot do this itself — it owns no message transport, by the same decision that keeps the
// FE postMessage bridge here rather than in the library. All it asks for is a function.

import { getSettings } from '@/config/settings';
import {
  NOTARY_PROVE,
  type NotaryProveMessage,
  type NotaryProveReply,
  type ProverOverrides,
} from '@/core/notary-messages';
import { beginProof, describeProofRequest, notaryTrace } from '@/core/notary-trace';

const OFFSCREEN_PATH = 'offscreen.html';

/**
 * A poisoned failure faster than this never engaged the wasm, so it is a proving context that cannot start —
 * recycle the document, not just the worker. A real trap needs the prover to RUN first (the observed ones took
 * seconds to minutes); a worker that cannot construct fails in single-digit milliseconds. One second sits
 * between the two with the same three-orders-of-magnitude margin the core's `countedFailureMinMs` uses.
 */
const ZOMBIE_FAILURE_MS = 1_000;

/**
 * Whether this browser can host the prover at all.
 *
 * A capability check, not a browser-name check, because the requirement is concrete: the prover needs
 * `SharedArrayBuffer`, which needs cross-origin isolation, which needs an offscreen document — and
 * `chrome.offscreen` is exactly what a browser lacking that story also lacks.
 *
 * Today this is false on Firefox. Its MV3 background is an event page where `Worker` exists, so the
 * missing piece is isolation, not threads: Firefox has not shipped `crossOriginIsolated` for extension
 * pages (Bugzilla 1673477, REOPENED — blocked on running each extension in its own process). Until
 * that lands, or upstream ships a single-threaded prover build that needs neither, proofs cannot run
 * there and the core falls back to client-reported reporting.
 */
export const supportsOffscreenProver = (): boolean =>
  typeof (browser as unknown as { offscreen?: unknown }).offscreen !== 'undefined';

/**
 * Build the delegate handed to `startTrackerWithEvents`. The delegate's signature is fixed by the core —
 * `(requestJson, notaryToken, steamAccessToken) => Promise<base64Presentation>` — so the prover's config
 * cannot arrive through it; it is captured here instead, at the one point that has both the resolved
 * overrides and the message channel.
 *
 * `requestJson` carries no credential — only deal/offer/trade/asset ids, the axis, and the public
 * `subjectSteamId`. The two tokens are separate arguments because they authenticate to different parties:
 * `notaryToken` (DMarket) to the notary service, `steamAccessToken` (Steam) to the proven `IEconService`
 * read. Both are resolved on the core's side of this seam precisely so the offscreen document never needs
 * its own refresh authority — and neither is logged here or anywhere downstream.
 *
 * A factory rather than a module-level constant because the config is per-start: the service worker
 * restarts the tracker whenever remote config or the debug endpoints change, and the delegate the core
 * holds must carry the values that restart resolved — not the ones the module was first evaluated with.
 */
export const createNotaryProofDelegate = (config: ProverOverrides) => async (
  requestJson: string,
  notaryToken: string,
  steamAccessToken: string,
): Promise<string> => {
  // Narration for the service-worker half of the seam, which is the half with no other witness. The core's
  // lifecycle stream only learns the outcome, and the offscreen document cannot report a document that was
  // never created — the state `chrome://extensions` showed while a proof was hanging ("Inspect views: service
  // worker" and no `offscreen.html`). Every line names the deal, because proofs run concurrently.
  const who = describeProofRequest(requestJson);
  const startedAt = Date.now();
  notaryTrace(`proof requested — ${who}, notary ${config.notary?.notaryUrl ?? '(none)'}`);
  // The console's only present-tense "a proof is running" signal — see `proofsInFlight` for what it fixes.
  // Released in a `finally` rather than on each exit path: there are three of those below, and a latch that
  // outlives its proof reports a permanent hang, which is worse than reporting nothing.
  const proofDone = beginProof(startedAt);
  try {
    const message: NotaryProveMessage = {
      type: NOTARY_PROVE,
      requestJson,
      notaryToken,
      steamAccessToken,
      config,
      // Read per proof, not captured at start: this is the knob to reach for while a wedge is happening, and a
      // remote publish must not need a tracker restart to take effect.
      stuckAfterMs: getSettings().web.notaryStuckAfterMs,
      proofsPerInstance: getSettings().web.notaryProofsPerInstance,
    };
    // Both steps under ONE deadline. Getting the document ready used to be awaited OUTSIDE it, and that is the
    // one hang the bound did not cover: neither `runtime.getContexts` nor `offscreen.createDocument` rejects if
    // it simply never settles, and the memoised `creating` promise would then wedge every later proof too. No
    // rejection means no `ProofFailed`, no `CycleCompleted` and no further line of any kind — which is exactly
    // the symptom the timeout was added for in the first place (see the KDoc below).
    const work = (async (): Promise<NotaryProveReply | undefined> => {
      const created = await ensureOffscreenDocument();
      notaryTrace(`proving context ${created ? 'created' : 'already open'} — ${who}`);
      // Reply type as sendMessage's own type argument rather than an assertion on the result — see the
      // note in src/ui/debug/messaging.ts for why the assertion form is fragile.
      return await browser.runtime.sendMessage<NotaryProveMessage, NotaryProveReply | undefined>(message);
    })();
    const reply = await withProofTimeout(work, who);

    // An absent reply means the document died mid-proof (MV3 can reclaim it). Surface that as itself
    // rather than as an undefined-property crash three frames away.
    if (!reply || !reply.ok) {
      const detail = reply ? reply.error : 'offscreen document gave no reply (was it torn down?)';
      const spentMs = Date.now() - startedAt;
      // A poisoned failure that arrived near-instantly is a ZOMBIE proving context, not a broken prover.
      // Offscreen documents survive service-worker restarts, and a document left over from before an extension
      // reload still answers `getContexts` (so `ensureOffscreenDocument` says "already open"), still receives
      // messages, still posts traces — but its realm can no longer construct the prover worker: `new Worker`
      // fails with a bare error Event before any wasm is engaged. Observed live on 2026-08-26: two proofs failed
      // in 7 ms and 15 ms with `prover worker errored: undefined`, and nothing recovered until Chrome collected
      // the zombie a minute later and the next attempt logged `proving context created`.
      //
      // Retrying a worker inside that document fails identically, so the recovery is the DOCUMENT's: recycle it
      // exactly as the timeout path below does, and the very next proof re-creates a fresh one instead of
      // waiting out the zombie. Gated on BOTH poisoned and near-instant — a trap mid-proof is poisoned too, but
      // it leaves a usable document, and the worker-level discard in the offscreen document already handles it.
      if (reply?.poisoned && spentMs < ZOMBIE_FAILURE_MS) {
        void closeOffscreenDocument().then((err) =>
          notaryTrace(
            err
              ? `zombie proving context close FAILED — ${who} — ${err}`
              : `zombie proving context closed (poisoned reply in ${spentMs}ms) — ${who}`,
            err ? 'error' : 'warn',
          ),
        );
        creating = null;
      }
      notaryTrace(`proof FAILED after ${spentMs}ms — ${who} — ${detail}`, 'error');
      throw new Error(`notary: ${detail}`);
    }
    notaryTrace(`proof produced in ${Date.now() - startedAt}ms (${reply.presentation.length} chars) — ${who}`);
    return reply.presentation;
  } finally {
    proofDone();
  }
};

/**
 * Bound one proof, and recycle the proving context if it overruns.
 *
 * Nothing else on this path has a deadline. The notary and proxy WebSockets reject on `error`/`close`, but a
 * socket stuck in CONNECTING — TLS up, HTTP upgrade never answered, which is exactly what an unreachable
 * notary route or proxy looks like — emits neither, so `whenReady()` never settles. The core awaits the proof
 * inline inside its watch pass, so that hang takes the whole tracker cycle with it: observed live as a cycle
 * that reported at 09:19:21 and then emitted nothing further, no `ProofFailed` and no `CycleCompleted`.
 *
 * The timeout alone would not be enough. The prover holds a `Semaphore(maxConcurrency)` permit for the
 * duration, so two abandoned proofs would block every later one for the life of the worker — a timeout that
 * merely stops waiting would convert an obvious wedge into a silent one. Tearing the document down is what
 * actually releases the permit, the socket and the wasm instance, and it is the recycling duty the core's
 * `notary-integration.md` assigns to the host and nothing implemented until now.
 *
 * Rejecting (rather than returning a failure reply) is deliberate: the core turns a thrown delegate into
 * `ProofFailed`, which withholds the deal's dedup baseline so the transition is re-detected and retried next
 * tick. A `verified: false` reply would instead be recorded as a terminal verdict.
 */
async function withProofTimeout(
  reply: Promise<NotaryProveReply | undefined>,
  who: string,
): Promise<NotaryProveReply | undefined> {
  const ms = getSettings().web.notaryProofTimeoutMs;
  // An explicit flag, not `timer !== undefined`: the executor runs synchronously, so the handle is set on
  // every path and could not distinguish "we gave up" from "the proof answered in time".
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`notary: proof timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([reply, deadline]);
  } finally {
    clearTimeout(timer);
    if (timedOut) {
      // Named explicitly rather than left to the generic failure line: "the proof overran and we recycled the
      // proving context" and "the prover reported an error" are different problems with the same symptom.
      notaryTrace(`proof TIMED OUT after ${ms}ms — ${who} — recycling the proving context`, 'error');
      // The abandoned proof still holds the prover's concurrency permit, its two WebSockets and the wasm
      // instance, so the document has to go — otherwise later proofs queue behind a proof nobody is waiting
      // for. A settled proof leaves it warm, which is the point of memoising the wasm.
      //
      // Whether it WORKED is traced, because a failed teardown predicts the next proof: the permit is still
      // held, so that proof times out too, and two identical timeout entries a minute apart are otherwise
      // indistinguishable from an unreachable notary. Fire-and-forget on purpose — awaiting it here would
      // delay the rejection the core is waiting on.
      void closeOffscreenDocument().then((err) =>
        notaryTrace(
          err ? `proving context close FAILED — ${who} — ${err}` : `proving context closed — ${who}`,
          err ? 'error' : 'info',
        ),
      );
      // Drop the memoised creation too. `creating` is cleared in a `.finally()`, which never runs for a
      // `createDocument` that simply never settles — so without this, every later proof awaits that same dead
      // promise and times out in turn. Bounding each attempt is not the same as recovering from one.
      creating = null;
      // And keep the abandoned promise from surfacing later as an unhandled rejection in the worker.
      void reply.catch(() => {});
    }
  }
}

/**
 * Tear down the proving context.
 *
 * @return `undefined` on success, or the failure's message. Reported rather than swallowed: "already gone" and
 * "the close call itself failed" have the same shape here but opposite consequences — the second leaves the
 * prover's concurrency permit held, which the caller's trace line turns into a prediction about the next proof.
 */
async function closeOffscreenDocument(): Promise<string | undefined> {
  try {
    await offscreenApi().closeDocument();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Create the offscreen document if it is not already there.
 *
 * Serialised through a module-level promise because proofs run concurrently (the core caps them at
 * `NotaryConfig.maxConcurrency`, default 2) and `createDocument` rejects if one already exists — two
 * parallel proofs would otherwise race into that error. The promise is cleared on failure so a genuine
 * retry can re-create it.
 */
let creating: Promise<void> | null = null;

/** @return `true` when this call created the document, `false` when one was already open. */
async function ensureOffscreenDocument(): Promise<boolean> {
  if (await hasOffscreenDocument()) return false;
  // `createDocument` is the one call here that can fail for reasons the caller cannot infer (an unsupported
  // `reasons` value, a second document, a missing page). Name it, or the loop reports only "proof failed".
  creating ??= offscreenApi()
    .createDocument({
      url: OFFSCREEN_PATH,
      // WORKERS is the accurate reason: the prover's rayon pool spawns real web workers, which is the
      // capability the service worker lacks.
      reasons: ['WORKERS'],
      justification:
        'Runs the TLSN prover, which needs Web Workers and SharedArrayBuffer to generate a trade proof.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
  return true;
}

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await runtimeWithContexts().getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [browser.runtime.getURL(`/${OFFSCREEN_PATH}`)],
  });
  return contexts.length > 0;
}

// `chrome.offscreen` and `runtime.getContexts` are Chrome-MV3-only and absent from the cross-browser
// `browser` typings WXT ships. Narrow casts here rather than `any` at each call site; the Firefox build
// never reaches this module (the delegate is only wired on Chrome).
type OffscreenApi = {
  createDocument(opts: { url: string; reasons: string[]; justification: string }): Promise<void>;
  closeDocument(): Promise<void>;
};
type RuntimeWithContexts = {
  getContexts(filter: { contextTypes: string[]; documentUrls: string[] }): Promise<unknown[]>;
};

const offscreenApi = (): OffscreenApi => (browser as unknown as { offscreen: OffscreenApi }).offscreen;
const runtimeWithContexts = (): RuntimeWithContexts =>
  browser.runtime as unknown as RuntimeWithContexts;
