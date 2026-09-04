import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { beginProof } from '@/core/notary-trace';
import { lastProofOutcome, recordProofFrame, recordProofStage, runningProof } from '@/debug/proofState';
import { describeRunningProof } from '@/debug/protocol';

// The present-tense half of the console's proof state. A healthy proof takes ~17s, of which ~11s is one
// stage, so what this renders is the whole answer to "is it hung or is it working?" — and the ways it can
// be WRONG are the point: a stage attributed to the wrong proof, or a latch that outlives the proof it
// belongs to, both report a hang that is not happening.

/** Every bracket this file opened, so a failing assertion cannot leak a latch into the next test. */
const opened: Array<() => void> = [];
const start = (since: number): void => void opened.push(beginProof(since));

beforeEach(() => {
  // The recorded stage is module state, and what retires it is being older than the proof in flight. Parking
  // it at the epoch gives every test a clean slate; the service worker gets the same effect for free, since
  // every later proof starts later.
  recordProofStage('stage none', 0);
});

afterEach(() => {
  for (const close of opened.splice(0)) close();
});

describe('runningProof', () => {
  it('is undefined when nothing is in flight', () => {
    expect(runningProof()).toBeUndefined();
  });

  it('reports the OLDEST proof and how many there are', () => {
    start(2_000);
    start(1_000);
    expect(runningProof()).toEqual({ since: 1_000, count: 2, stage: null });
  });

  it('names the stage the prover last reported', () => {
    start(1_000);
    recordProofStage('stage MPC_SETUP 10% — Setting up MPC with the notary…', 1_500);
    expect(runningProof()).toEqual({ since: 1_000, count: 1, stage: 'MPC_SETUP 10%' });
  });

  it('withholds the stage while TWO proofs run — the traces carry no deal id to attribute it by', () => {
    start(1_000);
    recordProofStage('stage REVEAL 70% — Proving and revealing data…', 1_500);
    start(1_600);
    expect(runningProof()?.stage).toBeNull();
  });

  it('withholds a stage recorded BEFORE this proof started — it belongs to the previous one', () => {
    // The exact shape of the bug this guard exists for: proof #1 finishes in FINALIZED, proof #2 starts, and
    // for the seconds before its first stage line the pill would otherwise claim it is already finalized.
    recordProofStage('stage FINALIZED 100% — Attestation finalized', 1_000);
    start(2_000);
    expect(runningProof()?.stage).toBeNull();
  });

  it('keeps the step when the wasm sends no percentage and no message', () => {
    start(1_000);
    recordProofStage('stage reveal', 1_100);
    expect(runningProof()?.stage).toBe('reveal');
  });

  it('ignores the relay lines that are not stages', () => {
    start(1_000);
    recordProofStage('ws#1 PROGRESS 5.0s sent 37.4MB (+37.4MB) recv 2.1MB (+2.1MB) wss://notary.test/', 1_100);
    recordProofStage('issuance serverName=api.steampowered.com rootStore=mozilla maxSent=1024', 1_200);
    expect(runningProof()?.stage).toBeNull();
  });
});

describe('describeRunningProof', () => {
  it('reads as elapsed time plus the stage', () => {
    expect(describeRunningProof({ since: 1_000, count: 1, stage: 'MPC_SETUP 10%' }, 13_400)).toBe(
      'running 12s · MPC_SETUP 10%',
    );
  });

  it('says how many when more than one is in flight, and drops the unattributable stage', () => {
    expect(describeRunningProof({ since: 1_000, count: 2, stage: null }, 4_000)).toBe('running 3s (2 proofs)');
  });

  it('clamps a future start to zero rather than counting backwards', () => {
    expect(describeRunningProof({ since: 9_000, count: 1, stage: null }, 1_000)).toBe('running 0s');
  });
});

describe('recordProofFrame', () => {
  it('reads a demanded proof as a step, not as a generation failure', () => {
    // The trap this branch exists for: the fallthrough at the end of `recordProofFrame` renders every
    // unrecognised proof frame as "FAILED to generate", so adding `FreshProofDemanded` to PROOF_EVENTS
    // without a branch of its own would report the backend ASKING for a proof as the client failing to make
    // one — the two opposite answers to the one question this surface exists to answer.
    recordProofFrame(
      'FreshProofDemanded',
      { dealId: 'deal-1', tradeId: '744935517744884653', proveAfter: '2026-09-02T10:15:30Z' },
      5_000,
    );
    const outcome = lastProofOutcome();
    expect(outcome?.ok).toBe(true);
    expect(outcome?.text).toContain('DEMANDED');
    expect(outcome?.text).toContain('744935517744884653');
    expect(outcome?.text).not.toContain('FAILED');
  });

  it('lets the verdict that follows a demand replace it', () => {
    // The demand is a step; the frame after it is the answer. A remembered "DEMANDED" outliving its own
    // verdict would be the same staleness the stage attribution above guards against.
    recordProofFrame('FreshProofDemanded', { dealId: 'deal-1', tradeId: 't1', proveAfter: 'x' }, 5_000);
    recordProofFrame('ProofSubmitted', { dealId: 'deal-1', source: 'history', verified: true }, 6_000);
    expect(lastProofOutcome()?.text).toContain('verified');
  });

  it('still reads an unknown proof frame as a generation failure', () => {
    // The fallthrough is deliberate and must stay: a frame this build does not recognise is more likely a
    // prover failure than anything else, and silence is the one answer that is never useful here.
    recordProofFrame('ProofFailed', { dealId: 'deal-1', source: 'history', reason: 'notary unreachable' }, 7_000);
    expect(lastProofOutcome()?.ok).toBe(false);
    expect(lastProofOutcome()?.text).toContain('FAILED to generate');
  });
});
