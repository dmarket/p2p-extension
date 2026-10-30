import { describe, expect, it } from 'vitest';
import { describeSnapshot, ProofStats, socketRole, stallReason, type ProofSnapshot } from '@/core/notary-snapshot';

const NOTARY = 'wss://notary.test/provenance/v1/';
const PROXY = 'wss://proxy.test/?host=api.steampowered.com&port=443';

/** A WebSocket as far as the stats can see one: a send queue whose depth a test sets. */
class FakeSocket {
  bufferedAmount = 0;
}

function setup(env: { cores?: number } = { cores: 8 }) {
  let now = 1_000;
  const stats = new ProofStats({ now: () => now, isolated: () => true, cores: () => env.cores });
  return { stats, tick: (ms: number) => (now += ms) };
}

describe('ProofStats', () => {
  it('builds a snapshot from both sockets: bytes, buffered, idle and close code', () => {
    const { stats, tick } = setup();
    stats.begin('aaaa0001', 4);
    const notarySock = new FakeSocket();
    const notary = stats.socket(NOTARY, notarySock);
    const proxy = stats.socket(PROXY, new FakeSocket());
    stats.opened(notary);
    stats.opened(proxy);
    stats.stage('aaaa0001', 'MPC_SETUP');
    stats.moved(notary, 'sent', 39_000_000);
    stats.moved(notary, 'recv', 2_000_000);
    notarySock.bufferedAmount = 65_536;
    tick(12_000); // nothing moves for 12 s
    stats.closed(proxy, 1006);

    expect(stats.snapshot('aaaa0001')).toEqual({
      stage: 'MPC_SETUP',
      stageSec: 12,
      elapsedMs: 12_000,
      notarySent: 39_000_000,
      notaryRecv: 2_000_000,
      notaryBuffered: 65_536,
      notaryIdleMs: 12_000,
      proxySent: 0,
      proxyRecv: 0,
      proxyBuffered: 0,
      proxyIdleMs: 12_000,
      proxyClose: 1006,
      concurrent: 1,
      threadCount: 4,
      isolated: true,
      cores: 8,
      freshWorker: true,
    } satisfies ProofSnapshot);
  });

  it('measures idle from the last byte, and has none before the socket opens', () => {
    const { stats, tick } = setup();
    stats.begin('aaaa0001');
    const s = stats.socket(NOTARY, new FakeSocket());
    expect(stats.snapshot('aaaa0001')!.notaryIdleMs).toBeUndefined();
    stats.opened(s);
    tick(5_000);
    stats.moved(s, 'recv', 14);
    tick(3_000);
    expect(stats.snapshot('aaaa0001')!.notaryIdleMs).toBe(3_000);
    // A zero-byte frame is not movement.
    stats.moved(s, 'sent', 0);
    tick(1_000);
    expect(stats.snapshot('aaaa0001')!.notaryIdleMs).toBe(4_000);
  });

  it('pins a socket only when one proof is in flight, so two concurrent proofs never share numbers', () => {
    const { stats } = setup();
    stats.begin('aaaa0001');
    const first = stats.socket(NOTARY, new FakeSocket());
    stats.moved(first, 'sent', 111);
    stats.begin('bbbb0002');
    // Created while two proofs run: it could be either's, so it is nobody's.
    const second = stats.socket(NOTARY, new FakeSocket());
    stats.moved(second, 'sent', 222);

    expect(first.proofId).toBe('aaaa0001');
    expect(second.proofId).toBeUndefined();
    expect(stats.snapshot('aaaa0001')).toMatchObject({ notarySent: 111, concurrent: 2, freshWorker: true });
    const b = stats.snapshot('bbbb0002')!;
    expect(b.notarySent).toBeUndefined();
    expect(b).toMatchObject({ concurrent: 2, freshWorker: false });
  });

  it('keeps a stage per proof', () => {
    const { stats } = setup();
    stats.begin('aaaa0001');
    stats.begin('bbbb0002');
    stats.stage('aaaa0001', 'REVEAL');
    stats.stage('bbbb0002', 'MPC_SETUP');
    expect(stats.snapshot('aaaa0001')!.stage).toBe('REVEAL');
    expect(stats.snapshot('bbbb0002')!.stage).toBe('MPC_SETUP');
  });

  it('forgets a proof once it ends', () => {
    const { stats } = setup();
    stats.begin('aaaa0001');
    stats.end('aaaa0001');
    expect(stats.snapshot('aaaa0001')).toBeUndefined();
  });

  it('omits the core count when the platform does not give one', () => {
    const { stats } = setup({});
    stats.begin('aaaa0001');
    expect(stats.snapshot('aaaa0001')).not.toHaveProperty('cores');
  });

  it('tells the proxy from the notary by its routing query', () => {
    expect(socketRole(PROXY)).toBe('proxy');
    expect(socketRole(NOTARY)).toBe('notary');
    expect(socketRole('not a url')).toBe('notary');
  });
});

describe('stallReason', () => {
  const snap = (over: Partial<ProofSnapshot>): ProofSnapshot => ({
    elapsedMs: 40_000,
    concurrent: 1,
    isolated: true,
    freshWorker: true,
    stage: 'MPC_SETUP',
    notaryIdleMs: 30_000,
    ...over,
  });

  it('fires at the threshold on a silent, open notary socket, with stage and silence in the reason', () => {
    expect(stallReason(snap({ notaryIdleMs: 29_999 }), 30_000)).toBeNull();
    expect(stallReason(snap({}), 30_000)).toBe('prover stalled: MPC_SETUP for 30s, 0 B notary traffic');
  });

  it('never fires with the default 0, whatever the silence', () => {
    expect(stallReason(snap({ notaryIdleMs: 10 * 60_000 }), 0)).toBeNull();
  });

  it('ignores a closed socket and one that never opened', () => {
    expect(stallReason(snap({ notaryClose: 1006 }), 30_000)).toBeNull();
    expect(stallReason(snap({ notaryIdleMs: undefined }), 30_000)).toBeNull();
  });
});

describe('describeSnapshot', () => {
  it('reads as one line, and says so when there was nothing to read', () => {
    expect(describeSnapshot(undefined)).toBe('no prover snapshot received');
    expect(
      describeSnapshot({ elapsedMs: 5, concurrent: 1, isolated: false, freshWorker: false, notarySent: 1, notaryRecv: 2, notaryBuffered: 3 }),
    ).toBe(
      'no stage; elapsed 5ms; notary sent 1B recv 2B buffered 3B; proxy –; concurrent 1; threads ? cores ?; NOT isolated; reused worker',
    );
  });
});
