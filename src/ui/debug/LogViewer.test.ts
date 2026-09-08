import { describe, expect, it } from 'vitest';

import { isProblem } from '@/ui/debug/LogViewer';
import type { LifecycleLogEntry } from '@/debug/protocol';

const entry = (event: string, fields?: LifecycleLogEntry['fields']): LifecycleLogEntry => ({
  category: 'lifecycle',
  event,
  fields,
});

describe('isProblem', () => {
  it('marks a refused directive report and a directive the core would not execute', () => {
    expect(isProblem(entry('DirectiveReportFailed'))).toBe(true);
    // Added with the core's refusal reporting: a dropped directive whose refusal cannot be answered for
    // keeps its lease until the TTL and comes back every heartbeat, with the deal standing still.
    expect(isProblem(entry('DirectiveDropped'))).toBe(true);
  });

  it('reads a deferred report by its reason, not by its name', () => {
    // Awaiting a verdict is a stuck deal...
    expect(
      isProblem(entry('TradeStatusReportDeferred', { reason: "withheld until this transition's proof verifies" })),
    ).toBe(true);
    // ...but a closure already reported unproven is the core working as intended, and used to show red.
    expect(
      isProblem(
        entry('TradeStatusReportDeferred', { reason: 'already reported unproven; awaiting a prover for its proof' }),
      ),
    ).toBe(false);
  });

  it('reads a submitted proof by its verdict field', () => {
    expect(isProblem(entry('ProofSubmitted', { verified: false }))).toBe(true);
    expect(isProblem(entry('ProofSubmitted', { verified: true }))).toBe(false);
  });

  it('leaves an unknown or healthy event in the normal colour', () => {
    expect(isProblem(entry('TradeStatusClaimedUnproven'))).toBe(false);
    expect(isProblem(entry('HeartbeatSent'))).toBe(false);
  });
});
