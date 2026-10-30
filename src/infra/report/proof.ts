// The notary proof path's outcomes → the collector.
//
// The core narrates the proof path only as lifecycle frames, and the host used to drop them in production: the
// debug console's session log was the one place a failure reason was visible. The notary meanwhile counts every
// retry as a failed session and has no way to see the client's side of it, so a fifth of its sessions failed
// with no account of why from anyone.
//
// Four frames are reported, all charged to the proof budget:
//  - `ProofFailed` — generation or delivery failed. Carries the prover's diagnostics when the delegate parked
//    them (src/infra/report/proofDiag.ts), which makes it a session summary;
//  - `ProofSubmitted{verified:false}` — the backend refused the proof, with its reason;
//  - `ProofSuppressed` and `TradeStatusReportDeferred` — states the core re-announces every tick, sent on the
//    occurrence ladder only (`steady`).
//
// Core-free, like the rest of the reporter surface, and SW-only in practice: background.ts hands every
// lifecycle frame to {@link reportProofEvent}.

import { takeProofDiag } from '@/infra/report/proofDiag';
import { reportError } from '@/infra/report/reporter';

/** Stable message prefixes (after describe.ts's `core: `), so the collector can select these rows with a `LIKE`. */
const PREFIX = {
  failed: 'notary proof failed',
  rejected: 'notary proof rejected',
  suppressed: 'notary proof suppressed',
  deferred: 'trade status report deferred',
} as const;

/** The core's axis names (`offer`, `history`). Anything else is reported as `unknown`, never echoed. */
const SOURCE = /^[a-z_]{1,24}$/;

/** The core's prover ids (`tlsn`, `noop`). */
const PROVER = /^[a-z]{1,16}$/;

/**
 * The fields of a proof lifecycle frame this module reads. Everything is `unknown`: it is parsed JSON.
 * `dealId` is read only as the key of the diagnostics hand-off; it is never part of a message.
 */
export interface ProofFrame {
  event?: unknown;
  dealId?: unknown;
  source?: unknown;
  reason?: unknown;
  demanded?: unknown;
  verified?: unknown;
  prover?: unknown;
  steamStatusCode?: unknown;
}

const sourceOf = (frame: ProofFrame): string =>
  typeof frame.source === 'string' && SOURCE.test(frame.source) ? frame.source : 'unknown';

const reasonOf = (frame: ProofFrame): string =>
  typeof frame.reason === 'string' && frame.reason ? frame.reason : 'no reason given';

/**
 * The report message for one `ProofFailed` frame. `reason` is the core's `redactedSummary()`, so the whole
 * message is reported as a core summary (see `MessageOrigin` in describe.ts). The deal id is deliberately
 * left out: report mode would blank it anyway, and an intact one is a join key to an account, which the
 * reporter's disclosures do not cover.
 */
export function describeProofFailure(frame: ProofFrame): string {
  const demanded = frame.demanded === true ? ', demanded' : '';
  return `${PREFIX.failed} (${sourceOf(frame)}${demanded}): ${reasonOf(frame)}`;
}

/**
 * The message for any reported proof frame, or `null` for a frame that is not reported (every other event, and
 * a proof the backend verified).
 */
export function describeProofEvent(frame: ProofFrame): string | null {
  switch (frame.event) {
    case 'ProofFailed':
      return describeProofFailure(frame);
    case 'ProofSubmitted': {
      if (frame.verified !== false) return null;
      // The prover matters here: a `noop` proof is refused by design, and that is a configuration finding.
      const prover = typeof frame.prover === 'string' && PROVER.test(frame.prover) ? `, ${frame.prover}` : '';
      return `${PREFIX.rejected} (${sourceOf(frame)}${prover}): ${reasonOf(frame)}`;
    }
    case 'ProofSuppressed':
      return `${PREFIX.suppressed} (${sourceOf(frame)}): ${reasonOf(frame)}`;
    case 'TradeStatusReportDeferred': {
      // A Steam status integer (`trade_offer_state` / trade `status`), not an id.
      const code = frame.steamStatusCode;
      const tag = typeof code === 'number' && Number.isInteger(code) && code >= 0 && code < 100 ? `, code ${code}` : '';
      return `${PREFIX.deferred} (${sourceOf(frame)}${tag}): ${reasonOf(frame)}`;
    }
    default:
      return null;
  }
}

/** Report the frame if it is one of the proof outcomes above. Synchronous and never throws. */
export function reportProofEvent(frame: ProofFrame): void {
  const message = describeProofEvent(frame);
  if (message === null) return;
  const failed = frame.event === 'ProofFailed';
  reportError(message, {
    coreSummary: true,
    proof: true,
    ...(failed ? { diag: takeProofDiag(frame.dealId, frame.source) } : {}),
    ...(frame.event === 'ProofSuppressed' || frame.event === 'TradeStatusReportDeferred' ? { steady: true } : {}),
  });
}
