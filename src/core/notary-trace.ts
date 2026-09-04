// Narration for the proof path, into whatever sink the host has — plus, at the bottom, the live register of
// proofs currently in flight, which is the same inversion applied to a fact rather than a line.
//
// WHY THIS EXISTS. The exported session log is the artifact a proof problem is actually diagnosed from, and
// until now the proof path contributed almost nothing to it. `netLog` wraps `globalThis.fetch` in the service
// worker, so it captures the `/notary` POST that carries a FINISHED presentation — and nothing about producing
// one. Everything upstream of that POST is invisible to it:
//   - the offscreen document and the prover worker are separate realms with their own `globalThis`, so the
//     ~10 MB wasm load leaves no trace;
//   - the notary and proxy connections are WebSockets, not fetches, so they would not be captured even from
//     the same realm.
// The result was that "a proof was never attempted", "a proof is still running", "the proving context never
// started" and "the proof hung" all rendered as the same thing in an exported log: absence. Three separate
// investigations were spent distinguishing them by hand from a browser console, which the person reporting a
// stuck deal generally cannot be asked to paste.
//
// The sink is injected rather than imported because `src/debug/` is stripped from production builds, so a
// production module cannot depend on it — the same inversion `DebugDeps.setLifecycleSink` uses for the core's
// lifecycle stream. With no sink installed (production) this is a console line and nothing else, which is
// deliberate: this path had never produced a single proof until today, so the console line is not dev-only.

import { redactSecrets } from '@/util/redact';

/** Where a trace line goes when the dev console is present. Mirrors `logCommand`'s shape by design. */
type NotaryTraceSink = (event: string, note: string, level: 'info' | 'warn' | 'error') => void;

/**
 * One tag for the whole path, so the log reads as one story and `note` carries the phase. Exported because
 * the proving realm's relayed lines must land under the same tag — two tags would split one story in half.
 */
export const NOTARY_TRACE_EVENT = 'NotaryProof';

let sink: NotaryTraceSink | undefined;

/** Installed by the dev-only debug bootstrap; absent in production. */
export function setNotaryTraceSink(next: NotaryTraceSink): void {
  sink = next;
}

/**
 * Record one phase of one proof.
 *
 * Scrubbed before it goes anywhere, and that is not merely defensive: the proven read's path carries
 * `?access_token=<steam jwt>` once the prover substitutes it, so a transport error naming the failed request
 * would otherwise print a live Steam credential into a log that has a one-click export. The request JSON
 * itself is credential-free by the core's own construction, but the failure strings on this path are not ours.
 *
 * Never throws: this runs inside the core's cycle, where a throw aborts it.
 */
export function notaryTrace(note: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  const safe = redactSecrets(note);
  console.info(`[notary/sw] ${safe}`);
  try {
    sink?.(NOTARY_TRACE_EVENT, safe, level);
  } catch {
    /* narration must never surface into the proof path */
  }
}

/** One proof the service worker is waiting on right now. */
export interface ProofInFlight {
  /** When the delegate was entered, epoch ms. */
  since: number;
}

/**
 * The proofs currently in flight, oldest first. Empty is the normal state.
 *
 * WHY THIS EXISTS, and why here rather than in `src/debug/proofState.ts` with the rest of the console's proof
 * state: that module only ever learns a proof HAPPENED, from the terminal lifecycle frame the core emits once
 * it is over. So for the ~17 s a healthy proof takes, nothing on any surface said one was running — the
 * header showed a `proof:` pill describing an outcome minutes old, and a periodic-alarm countdown that ticks
 * on regardless. Which is to say it looked exactly like a wedged tracker, the state this whole path's tracing
 * exists to make visible, and telling the two apart meant reading the session log. The bracket lives in this
 * module because the delegate that owns it ships in production and cannot import the debug tree — the same
 * inversion the sink above exists for.
 *
 * A Set of entries, NOT a map keyed by deal: the core runs up to `NotaryConfig.maxConcurrency` proofs at once
 * and a re-leased directive can put the same deal in flight twice, so the deal is not a key. The entry is its
 * own identity, which is what lets [beginProof] hand back a closer instead of a token to be matched.
 */
const inFlight = new Set<ProofInFlight>();

/**
 * Open the bracket.
 *
 * @return the function that closes it — call it on every exit path (a `finally`). Returning the closer rather
 *   than a token is what makes that unmissable: there is nothing to mismatch, and no second export that can be
 *   called with the wrong value. Idempotent, so a double close cannot make the count go negative.
 */
export function beginProof(at: number): () => void {
  const entry: ProofInFlight = { since: at };
  inFlight.add(entry);
  return () => void inFlight.delete(entry);
}

export const proofsInFlight = (): ProofInFlight[] => [...inFlight].sort((a, b) => a.since - b.since);

/**
 * Name the deal a trace line is about, from the core's own request JSON.
 *
 * Load-bearing rather than cosmetic: the core runs up to `NotaryConfig.maxConcurrency` proofs at once, so
 * without this the lines of two concurrent proofs interleave into one unreadable sequence — and the single
 * most common question about a stuck deal ("was a proof even attempted for THIS deal?") could not be answered
 * from the log at all. `NotaryProofRequest` is documented credential-free and holds exactly these ids.
 *
 * The `key=value` spelling is REQUIRED, not a style choice. A DMarket deal id is `<45-char opaque>:<uuid>`,
 * and the scrubber's coarse "long opaque run" rule eats that first half unless the value sits behind an
 * `…id`-shaped key (see `IDENTIFIER_SPAN` in src/util/redact.ts). Written as `deal <id>` it logged as
 * `deal <redacted 45 chars>:…` — the correlating half of the id gone from the one line that names it.
 * The axis is lower-cased to match the `source` spelling every lifecycle frame uses; two spellings of one
 * axis in one log is a needless reading tax.
 */
export function describeProofRequest(requestJson: string): string {
  try {
    const r = JSON.parse(requestJson) as Record<string, unknown>;
    const parts = [
      str(r['dealId']) && `dealId=${str(r['dealId'])}`,
      str(r['source']) && `axis=${str(r['source'])?.toLowerCase()}`,
      str(r['steamOfferId']) && `offerId=${str(r['steamOfferId'])}`,
      str(r['tradeId']) && `tradeId=${str(r['tradeId'])}`,
    ].filter(Boolean);
    return parts.length ? parts.join(', ') : '(request carried no ids)';
  } catch {
    // A request the host cannot parse still deserves a line — that would itself be the finding.
    return '(unparseable request)';
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
