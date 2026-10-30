import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingReport } from '@/infra/report/reporter';
import { flushMacrotasks, stubFetch, stubManifest } from '@/testing/stubs';

// The outbox's gates read env/config at module scope, so they are mocked (as in outbox.test.ts). Only the
// end-to-end privacy case below reaches them.
vi.mock('@/infra/config', () => ({
  isCollectorEnabled: () => true,
  collectorConfig: { url: 'https://collector.test/v1/collect' },
}));
vi.mock('@/infra/report/consent', () => ({
  isReportingEnabledByUser: () => Promise.resolve(true),
  hasDataCollectionGrant: () => Promise.resolve(true),
}));

// The reporter keeps per-spawn state (a fingerprint dedup and a send cap), and the diagnostics hand-off is
// module state too, so every test gets fresh copies.
let sent: PendingReport[];
type ProofModule = typeof import('@/infra/report/proof');
let reportProofEvent: ProofModule['reportProofEvent'];
let describeProofFailure: ProofModule['describeProofFailure'];
let parkProofDiag: (typeof import('@/infra/report/proofDiag'))['parkProofDiag'];
let reporter: typeof import('@/infra/report/reporter');

beforeEach(async () => {
  vi.resetModules();
  sent = [];
  reporter = await import('@/infra/report/reporter');
  reporter.setReportSink((r) => sent.push(r));
  ({ reportProofEvent, describeProofFailure } = await import('@/infra/report/proof'));
  ({ parkProofDiag } = await import('@/infra/report/proofDiag'));
});

const DEAL = `${'a'.repeat(45)}:4e67b308-1d2a-4f3b-8c9d-0577e9d2a1b4`;
const SNAPSHOT = { stage: 'MPC_SETUP', stageSec: 171.3, notarySent: 7_990_897, notaryIdleMs: 52_000, cores: 8 };

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

describe('reportProofEvent — ProofFailed', () => {
  it('sends one stackless core report charged to the proof budget', () => {
    reportProofEvent({ event: 'ProofFailed', source: 'offer', reason: 'IllegalStateException: boom' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ context: 'background', stack: null, proof: true });
    expect(sent[0]!.fromPage).toBeUndefined();
    expect(sent[0]!.diag).toBeUndefined();
  });

  it('keeps the prover error chain the core allowlist would cut at the first paren', () => {
    const reason =
      'IllegalStateException: notary session failed (mux): share conversion error: role error: bytes remaining on stream';
    reportProofEvent({ event: 'ProofFailed', source: 'offer', reason });
    expect(sent[0]!.message).toBe(`core: notary proof failed (offer): ${reason}`);
  });

  it('carries the stall reason the document fails a proof with, intact', () => {
    const reason = 'IllegalStateException: notary: prover worker discarded: prover stalled: MPC_SETUP for 30s, 0 B notary traffic';
    reportProofEvent({ event: 'ProofFailed', source: 'offer', reason });
    expect(sent[0]!.message).toBe(`core: notary proof failed (offer): ${reason}`);
  });

  it('holds the core to its summary cap', () => {
    reportProofEvent({ event: 'ProofFailed', source: 'offer', reason: `E: ${'x '.repeat(2000)}` });
    expect(sent[0]!.message.length).toBeLessThan(400);
  });

  it('still scrubs the reason in report mode', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3NjU2MTE5ODAwMDAwMDAwMCJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';
    reportProofEvent({
      event: 'ProofFailed',
      source: 'offer',
      reason: `JsException: GET /IEconService/GetTradeOffer/v1/?access_token=${jwt} for 76561198000000000 failed`,
    });
    const message = sent[0]!.message;
    expect(message).not.toContain(jwt);
    expect(message).not.toContain('76561198000000000');
    expect(message).toContain('GetTradeOffer');
  });

  it('carries the diagnostics parked for its own deal and axis, once', () => {
    parkProofDiag(DEAL, 'OFFER', { outcome: 'timeout', ...SNAPSHOT });
    reportProofEvent({ event: 'ProofFailed', dealId: DEAL, source: 'offer', reason: 'E: timed out' });
    expect(sent[0]!.diag).toEqual({ outcome: 'timeout', ...SNAPSHOT });
    // Taken, not peeked: a second failure of the same deal must not reuse it.
    reportProofEvent({ event: 'ProofFailed', dealId: DEAL, source: 'offer', reason: 'E: again' });
    expect(sent[1]!.diag).toBeUndefined();
  });

  it('a session summary bypasses the per-spawn dedup and cap; a plain failure does not', () => {
    for (let i = 0; i < 12; i += 1) {
      parkProofDiag(DEAL, 'offer', { outcome: 'timeout', notarySent: i });
      reportProofEvent({ event: 'ProofFailed', dealId: DEAL, source: 'offer', reason: 'E: timed out' });
    }
    expect(sent).toHaveLength(12);
    // Same message twice without diagnostics: the second is a repeat, as before.
    reportProofEvent({ event: 'ProofFailed', source: 'history', reason: 'E: same' });
    reportProofEvent({ event: 'ProofFailed', source: 'history', reason: 'E: same' });
    expect(sent).toHaveLength(13);
  });

  it('leaves diagnostics out of the fingerprint', () => {
    parkProofDiag(DEAL, 'offer', { outcome: 'timeout', notarySent: 1 });
    reportProofEvent({ event: 'ProofFailed', dealId: DEAL, source: 'offer', reason: 'E: timed out' });
    parkProofDiag(DEAL, 'offer', { outcome: 'failed', notarySent: 2, stage: 'REVEAL' });
    reportProofEvent({ event: 'ProofFailed', dealId: DEAL, source: 'offer', reason: 'E: timed out' });
    expect(sent[0]!.diag).not.toEqual(sent[1]!.diag);
    expect(sent[0]!.fingerprint).toBe(sent[1]!.fingerprint);
  });
});

describe('reportProofEvent — the other proof outcomes', () => {
  it('reports a rejected proof with the backend reason and the prover, and ignores a verified one', () => {
    reportProofEvent({ event: 'ProofSubmitted', source: 'offer', verified: true, reason: null, prover: 'tlsn' });
    expect(sent).toHaveLength(0);
    reportProofEvent({
      event: 'ProofSubmitted',
      dealId: DEAL,
      source: 'offer',
      verified: false,
      reason: 'the proof covers the sent-offers list, not the trade history',
      prover: 'tlsn',
    });
    expect(sent[0]).toMatchObject({
      message: 'core: notary proof rejected (offer, tlsn): the proof covers the sent-offers list, not the trade history',
      proof: true,
    });
    expect(sent[0]!.steady).toBeUndefined();
  });

  it('reports a suppressed proof and a deferred report as steady states', () => {
    reportProofEvent({ event: 'ProofSuppressed', dealId: DEAL, source: 'offer', reason: 'PROOF_ALREADY_REFUSED' });
    reportProofEvent({
      event: 'TradeStatusReportDeferred',
      dealId: DEAL,
      source: 'history',
      steamStatusCode: 3,
      reason: 'withheld until this transition’s proof verifies',
    });
    expect(sent.map((r) => [r.message, r.steady, r.proof])).toEqual([
      ['core: notary proof suppressed (offer): PROOF_ALREADY_REFUSED', true, true],
      ['core: trade status report deferred (history, code 3): withheld until this transition’s proof verifies', true, true],
    ]);
  });

  it('ignores every other lifecycle frame', () => {
    for (const event of ['CycleCompleted', 'TradeStatusReported', 'FreshProofDemanded', undefined]) {
      reportProofEvent({ event, source: 'offer', reason: 'E: boom', verified: false });
    }
    expect(sent).toHaveLength(0);
  });
});

describe('privacy, end to end through the outbox', () => {
  it('no POSTed body carries a steamid, deal/offer/trade id, dm_did or a token', async () => {
    stubManifest([]);
    const fetchMock = stubFetch();
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    const { enqueue, flush } = await import('@/infra/report/outbox');
    reporter.setReportSink(enqueue);

    const STEAMID = '76561198338780301';
    const OFFER = '9311607911';
    const TRADE = '744935517744884653';
    const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3NjU2MSJ9.c2lnbmF0dXJl';
    // Every reason is hostile: ids in each shape a core or backend string could carry them.
    const leaky = `GET /IEconService/GetTradeOffer/v1/?tradeofferid=${OFFER}&access_token=${TOKEN} for ${STEAMID}; dealId=${DEAL}, tradeId=${TRADE}, dm_did=web-device, trade ${TRADE}`;
    parkProofDiag(DEAL, 'offer', {
      outcome: 'timeout',
      proofId: 'a1b2c3d4',
      ...SNAPSHOT,
      dealId: DEAL,
      steamOfferId: OFFER,
      tradeId: TRADE,
      subjectSteamId: STEAMID,
    });
    reportProofEvent({ event: 'ProofFailed', dealId: DEAL, source: 'offer', reason: `E: ${leaky}` });
    reportProofEvent({ event: 'ProofSubmitted', dealId: DEAL, source: 'offer', verified: false, reason: leaky, prover: 'tlsn' });
    reportProofEvent({ event: 'ProofSuppressed', dealId: DEAL, source: 'offer', reason: leaky });
    reportProofEvent({ event: 'TradeStatusReportDeferred', dealId: DEAL, source: 'offer', steamStatusCode: 2, reason: leaky });
    for (let i = 0; i < 4; i += 1) {
      await flushMacrotasks();
      await flush();
    }

    const bodies = fetchMock.mock.calls.map((c) => (c[1] as RequestInit).body as string);
    expect(bodies).toHaveLength(4);
    const withDiag = bodies.map((b) => JSON.parse(b) as { diag?: unknown }).filter((b) => b.diag !== undefined);
    expect(withDiag).toHaveLength(1);
    for (const body of bodies) {
      expect(body).not.toMatch(/\d{17}/);
      for (const secret of [OFFER, TRADE, 'a'.repeat(45), '0577e9d2a1b4', TOKEN, 'web-device']) {
        expect(body).not.toContain(secret);
      }
    }
  });
});
