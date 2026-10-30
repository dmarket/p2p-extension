// Hand-off of a failed proof's diagnostics from the proof delegate to the `ProofFailed` report.
//
// The two never meet: the delegate throws, the core catches it on a later tick and emits `ProofFailed{dealId,
// source, reason}` through the lifecycle stream, and only then does src/infra/report/proof.ts see the failure.
// The core's frame carries no snapshot and cannot — its `reason` is a capped one-line summary. So the delegate
// parks the diagnostics here under the frame's own key, and the report takes them.
//
// The deal id is a key in memory and nothing more: it never enters the stored value, and the report built from
// it carries none (see proof.ts). Service-worker memory only — a respawn between the two loses the hand-off,
// and the report then goes out without `diag`, as it did before.

/**
 * How long a parked entry waits for its frame. The core emits `ProofFailed` in the same catch that saw the
 * delegate reject, so milliseconds is the norm; the bound is for a cycle torn down in between, whose entry would
 * otherwise attach to the next failure of the same deal.
 */
const TTL_MS = 60_000;

/** Bound on parked entries; the oldest goes first. Proofs run two at a time, so this is generous. */
const MAX_ENTRIES = 16;

interface Parked {
  key: string;
  at: number;
  diag: Readonly<Record<string, unknown>>;
}

/** Oldest first. A list, not a map: the same deal and axis can be in flight twice (a re-leased directive). */
let parked: Parked[] = [];

const keyOf = (dealId: unknown, source: unknown): string | undefined =>
  typeof dealId === 'string' && dealId !== '' && typeof source === 'string' && source !== ''
    ? `${dealId}|${source.toLowerCase()}`
    : undefined;

function prune(now: number): void {
  parked = parked.filter((p) => now - p.at < TTL_MS).slice(-MAX_ENTRIES);
}

/**
 * Park a failed proof's raw diagnostics. Unvalidated on purpose: the report path serialises through the
 * allowlist (diag.ts), and validating twice in two places is how they drift.
 *
 * @param source the request's axis in either case (`OFFER` from the request JSON, `offer` from the frame).
 */
export function parkProofDiag(dealId: unknown, source: unknown, diag: Readonly<Record<string, unknown>>): void {
  const key = keyOf(dealId, source);
  if (key === undefined) return;
  const now = Date.now();
  prune(now);
  parked.push({ key, at: now, diag });
  if (parked.length > MAX_ENTRIES) parked.shift();
}

/**
 * Take the oldest diagnostics parked for this deal and axis, or `undefined`. Oldest, because the core reports
 * failures in the order it observed them, so with the same deal in flight twice the first frame belongs to the
 * first failure.
 */
export function takeProofDiag(dealId: unknown, source: unknown): Readonly<Record<string, unknown>> | undefined {
  const key = keyOf(dealId, source);
  if (key === undefined) return undefined;
  prune(Date.now());
  const i = parked.findIndex((p) => p.key === key);
  if (i < 0) return undefined;
  return parked.splice(i, 1)[0]!.diag;
}
