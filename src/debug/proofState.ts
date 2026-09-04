// The last thing that happened to a proof, remembered so the console can state it.
//
// WHY THIS EXISTS. "Why is there no `POST /p2p/ext/notary`?" is not answerable from the surfaces the console
// had. The header reported `prover=tlsn`, which says a real prover is CONFIGURED — not that a proof is being
// attempted. Force tick answered `heartbeat forced` at info level, which is true and useless: the cycle it
// forced skipped the proof. And the one frame that does explain it, `ProofSuppressed`, is a single row that a
// long session scrolls away, the ring buffer eventually evicts, and pressing `clear` destroys.
//
// So the fact was in the log exactly once, in the past, while the question is always asked in the present.
// This keeps the latest answer to hand.
//
// In-memory on purpose: it mirrors an in-memory latch inside the core, and a service-worker respawn clears
// both. Persisting it would let the console claim a suppression that the new loop instance has already
// forgotten — the opposite of the problem this solves.

import { parseStageLine } from '@/core/notary-messages';
import { proofsInFlight } from '@/core/notary-trace';
import type { ProofProgress } from '@/debug/protocol';

/** The proof-related lifecycle frames, and what each means for "was a proof attempted?". */
const PROOF_EVENTS = new Set(['ProofSubmitted', 'ProofFailed', 'ProofSuppressed', 'FreshProofDemanded']);

type Fields = Record<string, string | number | boolean | null>;

export interface ProofOutcome {
  /** One line for the console, already scrubbed (the fields arrive scrubbed from `logLifecycle`). */
  text: string;
  /** Whether this is a healthy outcome. `false` drives the failure colour, and is the common case today. */
  ok: boolean;
  at: number;
}

let last: ProofOutcome | undefined;

/**
 * Called for every lifecycle frame; keeps only the proof ones.
 *
 * Takes the already-parsed, already-redacted fields rather than the raw JSON so there is one parse and one
 * redaction pass per frame, and so this cannot become a second place where a raw core string is trusted.
 */
export function recordProofFrame(event: string, fields: Fields | undefined, at: number): void {
  if (!PROOF_EVENTS.has(event)) return;
  const reason = typeof fields?.['reason'] === 'string' ? fields['reason'] : undefined;
  const axis = typeof fields?.['source'] === 'string' ? fields['source'] : undefined;
  const where = axis ? ` (${axis} axis)` : '';
  if (event === 'ProofSubmitted') {
    const verified = fields?.['verified'] === true;
    last = {
      text: verified ? `verified${where}` : `REFUSED by the backend${where}${reason ? ` — ${reason}` : ''}`,
      ok: verified,
      at,
    };
    return;
  }
  if (event === 'ProofSuppressed') {
    // The one that answers the question: no proof was attempted, so there is no POST to look for.
    last = { text: `NOT ATTEMPTED${where}${reason ? ` — ${reason}` : ''}`, ok: false, at };
    return;
  }
  if (event === 'FreshProofDemanded') {
    // Needs a branch of its own, not just membership in the set above: the fallthrough below reads every
    // unknown proof frame as a generation failure, so adding the name alone would render the backend ASKING
    // for a proof as the client failing to make one — the two opposite answers to the same question.
    //
    // `ok: true` because nothing has gone wrong yet. It is a step, and the frame that follows is the verdict;
    // this exists so the header says "a demand is being answered right now" instead of showing the previous
    // cycle's outcome for the ~17 s an MPC session takes.
    const trade = typeof fields?.['tradeId'] === 'string' ? fields['tradeId'] : undefined;
    const mark = typeof fields?.['proveAfter'] === 'string' ? fields['proveAfter'] : undefined;
    last = {
      text: `DEMANDED by the backend${trade ? ` (trade ${trade})` : ''}${mark ? ` — attest after ${mark}` : ''}`,
      ok: true,
      at,
    };
    return;
  }
  last = { text: `FAILED to generate${where}${reason ? ` — ${reason}` : ''}`, ok: false, at };
}

/** The latest proof outcome this worker has seen, or `undefined` if no proof frame has arrived yet. */
export const lastProofOutcome = (): ProofOutcome | undefined => last;

// ---- the proof that is running RIGHT NOW ------------------------------------------------------------
//
// The other half of the question above. `lastProofOutcome` is a REMEMBERED verdict that outlives its cycle,
// so while a proof runs the console showed the previous one, and nothing else on the header moved either.
// A healthy proof takes ~16-17 s (measured live on dev 2026-08-28: 10.8 s of it inside `MPC_SETUP` alone,
// pushing ~38 MB of pre-processing to the notary before Steam is even dialled), which is long enough that
// "working" and "wedged" have to be told apart — and nothing told them apart. The bracket itself lives in
// src/core/notary-trace.ts, because the delegate that owns it ships in production; what is added here is the
// stage label, which only exists as trace text.

/** The last stage the proving realm reported, whenever that was. */
let stage: { label: string; at: number } | undefined;

/** Mirror a line relayed from the proving realm, keeping the stage ones (see [parseStageLine]). */
export function recordProofStage(note: string, at: number): void {
  const label = parseStageLine(note);
  if (label) stage = { label, at };
}

/**
 * The proof in progress, or `undefined` when none is.
 *
 * The stage is reported only when ONE proof is in flight **and** the stage line arrived after that proof
 * started. Both guards are about attribution: the relayed lines carry no deal id, so with two concurrent
 * proofs the stage belongs to neither in particular, and a stage left over from the previous proof would
 * pin the pill to a stage this proof never entered — a wrong answer on the surface a wedge is read from is
 * worse than no answer. The proving realm applies the same rule to its socket ticks, against its own count
 * (`stageNote` in src/entrypoints/offscreen/prover-worker.ts).
 */
export function runningProof(): ProofProgress | undefined {
  const running = proofsInFlight();
  const oldest = running[0];
  if (!oldest) return undefined;
  return {
    since: oldest.since,
    count: running.length,
    // Narrowed inline rather than through a `const` flag: `stage` is module-level and mutable, which is
    // exactly the case TypeScript refuses to carry an aliased condition into.
    stage: running.length === 1 && stage && stage.at >= oldest.since ? stage.label : null,
  };
}
