// Failed notary proofs → the collector.
//
// The core narrates a failed proof only as a `ProofFailed` lifecycle frame (generation or delivery failed,
// so the backend never saw the proof), and the host used to drop that frame in production: the debug
// console's session log was the one place a failure reason was visible. The notary meanwhile counts every
// retry as a failed session and has no way to see the client's side of it, so a fifth of its sessions
// failed with no account of why from anyone.
//
// Core-free, like the rest of the reporter surface, and SW-only in practice: background.ts hands every
// lifecycle frame to {@link reportIfProofFailed}.

import { reportError } from '@/infra/report/reporter';

/** Stable message prefix (after describe.ts's `core: `), so the collector can select these rows with one `LIKE`. */
const PROOF_FAILURE_PREFIX = 'notary proof failed';

/** The core's axis names (`offer`, `history`). Anything else is reported as `unknown`, never echoed. */
const SOURCE = /^[a-z_]{1,24}$/;

/** The fields of a lifecycle frame this module reads. Everything is `unknown`: it is parsed JSON. */
export interface ProofFailedFrame {
  event?: unknown;
  source?: unknown;
  reason?: unknown;
  demanded?: unknown;
}

/**
 * The report message for one `ProofFailed` frame. `reason` is the core's `redactedSummary()`, so the whole
 * message is reported as a core summary (see `MessageOrigin` in describe.ts). The deal id is deliberately
 * left out: report mode would blank it anyway, and an intact one is a join key to an account, which the
 * reporter's disclosures do not cover.
 */
export function describeProofFailure(frame: ProofFailedFrame): string {
  const source = typeof frame.source === 'string' && SOURCE.test(frame.source) ? frame.source : 'unknown';
  const demanded = frame.demanded === true ? ', demanded' : '';
  const reason = typeof frame.reason === 'string' && frame.reason ? frame.reason : 'no reason given';
  return `${PROOF_FAILURE_PREFIX} (${source}${demanded}): ${reason}`;
}

/** Report the frame if it is a `ProofFailed`, charged to the proof budget. Synchronous and never throws. */
export function reportIfProofFailed(frame: ProofFailedFrame): void {
  if (frame.event !== 'ProofFailed') return;
  reportError(describeProofFailure(frame), { coreSummary: true, proof: true });
}
