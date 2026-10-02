import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingReport } from '@/infra/report/reporter';

// The reporter keeps per-spawn state (a fingerprint dedup and a send cap), so every test gets a fresh copy.
let sent: PendingReport[];
let reportIfProofFailed: (typeof import('@/infra/report/proof'))['reportIfProofFailed'];
let describeProofFailure: (typeof import('@/infra/report/proof'))['describeProofFailure'];

beforeEach(async () => {
  vi.resetModules();
  sent = [];
  const reporter = await import('@/infra/report/reporter');
  reporter.setReportSink((r) => sent.push(r));
  ({ reportIfProofFailed, describeProofFailure } = await import('@/infra/report/proof'));
});

describe('describeProofFailure', () => {
  it('names the axis, the demand and the core reason under one stable prefix', () => {
    expect(describeProofFailure({ source: 'offer', reason: 'IllegalStateException: boom', demanded: false })).toBe(
      'notary proof failed (offer): IllegalStateException: boom',
    );
    expect(describeProofFailure({ source: 'history', reason: 'x', demanded: true })).toBe(
      'notary proof failed (history, demanded): x',
    );
  });

  it('never echoes a field it does not recognise', () => {
    expect(describeProofFailure({ source: 'offer<script>', reason: 42 })).toBe(
      'notary proof failed (unknown): no reason given',
    );
    expect(describeProofFailure({ reason: '' })).toBe('notary proof failed (unknown): no reason given');
  });
});

describe('reportIfProofFailed', () => {
  it('sends one stackless core report charged to the proof budget', () => {
    reportIfProofFailed({ event: 'ProofFailed', source: 'offer', reason: 'IllegalStateException: boom' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ context: 'background', stack: null, proof: true });
    expect(sent[0]!.fromPage).toBeUndefined();
  });

  it('ignores every other lifecycle frame', () => {
    for (const event of ['ProofSubmitted', 'ProofSuppressed', 'CycleCompleted', undefined]) {
      reportIfProofFailed({ event, source: 'offer', reason: 'IllegalStateException: boom' });
    }
    expect(sent).toHaveLength(0);
  });

  it('keeps the prover error chain the core allowlist would cut at the first paren', () => {
    const reason =
      'IllegalStateException: notary session failed (mux): share conversion error: role error: bytes remaining on stream';
    reportIfProofFailed({ event: 'ProofFailed', source: 'offer', reason });
    expect(sent[0]!.message).toBe(`core: notary proof failed (offer): ${reason}`);
  });

  it('holds the core to its summary cap', () => {
    reportIfProofFailed({ event: 'ProofFailed', source: 'offer', reason: `E: ${'x '.repeat(2000)}` });
    expect(sent[0]!.message.length).toBeLessThan(400);
  });

  it('still scrubs the reason in report mode', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3NjU2MTE5ODAwMDAwMDAwMCJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
    reportIfProofFailed({
      event: 'ProofFailed',
      source: 'offer',
      reason: `JsException: GET /IEconService/GetTradeOffer/v1/?access_token=${jwt} for 76561198000000000 failed`,
    });
    const message = sent[0]!.message;
    expect(message).not.toContain(jwt);
    expect(message).not.toContain('76561198000000000');
    expect(message).toContain('GetTradeOffer');
  });
});
