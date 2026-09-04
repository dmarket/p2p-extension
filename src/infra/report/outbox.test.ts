import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_KEY, POLICY_KEY } from '@/infra/report/keys';
import type { PendingReport } from '@/infra/report/reporter';
import { flushMacrotasks, stubFetch, stubManifest } from '@/testing/stubs';

// The enqueue/flush policy — the suite that found the two shipped bugs the assertions below are named
// for: (1) the budget/cooldown/dropped counters were committed BEFORE the POST, so an offline spell
// silently burned the day's allowance and then suppressed its own retry; (2) the occurrence ladder
// counted per-queue-item, but a sent item leaves the queue, so the count was always 1 — and
// isLadderStep(1) is true, so the cooldown never bound at all.

// Both gate modules read env/config at module scope, so they are mocked rather than env-stubbed.
// `vi.hoisted` because vi.mock factories are hoisted above the consts they close over.
const consent = vi.hoisted(() => ({ enabled: true, granted: true }));
vi.mock('@/infra/config', () => ({
  isCollectorEnabled: () => true,
  collectorConfig: { url: 'https://collector.test/v1/collect' },
}));
vi.mock('@/infra/report/consent', () => ({
  isReportingEnabledByUser: () => Promise.resolve(consent.enabled),
  hasDataCollectionGrant: () => Promise.resolve(consent.granted),
}));

const { enqueue, flush } = await import('@/infra/report/outbox');

const report = (fingerprint: string, over: Partial<PendingReport> = {}): PendingReport => ({
  context: 'background',
  message: `boom ${fingerprint}`,
  stack: null,
  fingerprint,
  timestamp: '2026-08-27T00:00:00.000Z',
  ...over,
});

const readQueue = async (): Promise<{ fingerprint: string; count: number }[]> =>
  ((await browser.storage.local.get(QUEUE_KEY))[QUEUE_KEY] as { fingerprint: string; count: number }[]) ?? [];

const readPolicy = async (): Promise<Record<string, unknown>> =>
  ((await browser.storage.local.get(POLICY_KEY))[POLICY_KEY] as Record<string, unknown>) ?? {};

/** The POSTed message of call #n (0-based) on the fetch mock. */
const sentMessage = (fetchMock: ReturnType<typeof stubFetch>, n: number): string =>
  (JSON.parse((fetchMock.mock.calls[n]![1] as RequestInit).body as string) as { message: string }).message;

let fetchMock: ReturnType<typeof stubFetch>;
beforeEach(() => {
  consent.enabled = true;
  consent.granted = true;
  fetchMock = stubFetch();
  // buildPayload stamps `manifest.version` — the fake's getManifest throws until stubbed, and a
  // throwing buildPayload makes send() settle items WITHOUT a POST, which would pass most assertions
  // here vacuously.
  stubManifest([]);
});

/**
 * enqueue() is deliberately fire-and-forget, and flush() returns IMMEDIATELY when another flush is
 * mid-flight (the `flushing` reentrancy guard) — so one awaited flush can race the enqueue-triggered
 * one and let its commits land after this test's assertions (or worse, after the next test's storage
 * reset). Alternate macrotask turns with flushes until both are provably quiescent.
 */
const settled = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) {
    await flushMacrotasks();
    await flush();
  }
};

describe('queue admission', () => {
  it('collapses a repeated fingerprint into the queued item instead of spending a slot', async () => {
    fetchMock.mockRejectedValue(new Error('offline')); // hold everything in the queue
    enqueue(report('fp-a'));
    enqueue(report('fp-a'));
    enqueue(report('fp-b'));
    await settled();

    const queue = await readQueue();
    expect(queue.map((q) => [q.fingerprint, q.count])).toEqual([
      ['fp-a', 2],
      ['fp-b', 1],
    ]);
  });

  it('drops the NEWEST above the cap and counts the loss', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 8; i += 1) enqueue(report(`fp-${i}`));
    await settled();

    const queue = await readQueue();
    expect(queue).toHaveLength(6); // MAX_QUEUED
    // Drop-newest: the first report of an episode is the one worth having.
    expect(queue[0]!.fingerprint).toBe('fp-0');
    expect((await readPolicy()).dropped).toBe(2);
  });

  it('a 20-report burst is serialised through storage without under-counting', async () => {
    // The regression the `serial` chain exists for: concurrent read-modify-writes of the same keys
    // would all read the same counters and lose all but the last write.
    fetchMock.mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 20; i += 1) enqueue(report(`burst-${i}`));
    await settled();

    expect(await readQueue()).toHaveLength(6);
    expect((await readPolicy()).dropped).toBe(14);
  });
});

describe('commit-after-POST (the offline-spell regression)', () => {
  it('a failed send burns no budget, arms no cooldown, and keeps the item for the next drain', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    enqueue(report('fp-off'));
    await settled();

    expect(await readQueue()).toHaveLength(1); // still queued
    const policy = await readPolicy();
    expect(policy.internal ?? 0).toBe(0); // no budget slot burned
    expect(policy.lastSent ?? {}).toEqual({}); // no cooldown armed against the retry

    // Back online: the SAME item drains with exactly ONE more POST. (The failed attempts above are
    // legitimate retries — every settled() pass re-tried the kept item; what matters is that none of
    // them committed anything.)
    const attemptsWhileOffline = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await flush();
    expect(fetchMock.mock.calls).toHaveLength(attemptsWhileOffline + 1);
    expect(await readQueue()).toHaveLength(0);
    expect((await readPolicy()).internal).toBe(1);
  });

  it('a 4xx is a schema rejection: settled (no retry loop), and committed', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 400 }));
    enqueue(report('fp-schema'));
    await settled();
    expect(await readQueue()).toHaveLength(0);
  });

  it('a 5xx is retried later, like offline', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    enqueue(report('fp-5xx'));
    await settled();
    expect(await readQueue()).toHaveLength(1);
  });
});

describe('the cumulative occurrence ladder', () => {
  it('sends occurrences 1, 2 and 4; suppresses 3 (the count survives a send)', async () => {
    // Pre-fix, the count reset when the sent item left the queue — every sighting was occurrence 1,
    // isLadderStep(1) is true, and the cooldown never bound.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const seq: number[] = [];
    for (let i = 1; i <= 4; i += 1) {
      enqueue(report('fp-ladder'));
      await settled();
      seq.push(fetchMock.mock.calls.length);
    }
    // Cumulative sends after each sighting: 1st sends, 2nd sends (ladder), 3rd suppressed, 4th sends.
    expect(seq).toEqual([1, 2, 2, 3]);
    // The suppressed sighting was dropped from the queue, not held.
    expect(await readQueue()).toHaveLength(0);
    // And the running total is stored, so the ladder keeps counting across sends.
    expect((await readPolicy()).occurrences).toEqual({ 'fp-ladder': 4 });
  });

  it('annotates a collapsed repeat with its occurrence count', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    enqueue(report('fp-x2'));
    enqueue(report('fp-x2'));
    await settled();
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await flush();
    expect(sentMessage(fetchMock, fetchMock.mock.calls.length - 1)).toContain('(x2)');
  });

  it('surfaces the dropped count on the next successful send, then resets it', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 7; i += 1) enqueue(report(`fp-drop-${i}`));
    await settled();
    expect((await readPolicy()).dropped).toBe(1);

    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await flush();
    // The first message of the drain carries the notice; `- 6` is the six items this flush sends.
    expect(sentMessage(fetchMock, fetchMock.mock.calls.length - 6)).toContain('(+1 dropped)');
    expect((await readPolicy()).dropped).toBe(0);
  });
});

describe('daily budgets', () => {
  it('the page bucket exhausts at its own (smaller) cap with exactly one notice, internal unaffected', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    // maxPerDayFromPage is 3 (compiled default). Five distinct page reports:
    for (let i = 0; i < 5; i += 1) {
      enqueue(report(`fp-page-${i}`, { fromPage: true }));
      await settled();
    }
    // 3 sent + 1 budget notice; the 5th is silent.
    expect(fetchMock.mock.calls).toHaveLength(4);
    expect(sentMessage(fetchMock, 3)).toContain('page report budget exhausted');

    // The internal bucket is untouched by the page flood — this is the anti-blinding property.
    enqueue(report('fp-internal'));
    await settled();
    expect(fetchMock.mock.calls).toHaveLength(5);
    const policy = await readPolicy();
    // 4, not 3: the notice send itself is charged to the bucket it announces (harmless — the bucket is
    // already over its cap — and it keeps "sent a POST" and "incremented the counter" one invariant).
    expect(policy.page).toBe(4);
    expect(policy.internal).toBe(1);
  });
});

describe('the UTC day roll', () => {
  it('a new day resets the budget, the ladder AND the notice flag (the shared-EMPTY_POLICY regression)', async () => {
    // Pre-fix, `rollDay` built the new day by spreading a module-scope EMPTY_POLICY whose three map
    // fields flush() had been MUTATING in place — so the roll reset nothing within a worker lifetime,
    // and yesterday's `noticeSent` silently suppressed today's budget-exhausted notice.
    vi.useFakeTimers({ toFake: ['Date'] }); // Date only: setTimeout must stay real for settled()
    try {
      vi.setSystemTime(new Date('2026-08-27T10:00:00Z'));
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      // Exhaust the page bucket (cap 3) and burn its once-a-day notice.
      for (let i = 0; i < 5; i += 1) {
        enqueue(report(`fp-day-${i}`, { fromPage: true }));
        await settled();
      }
      expect(fetchMock.mock.calls).toHaveLength(4); // 3 + the notice
      expect(sentMessage(fetchMock, 3)).toContain('budget exhausted');

      // Next UTC day: budget is back, and the fingerprint suppressed yesterday sends as a fresh sighting.
      vi.setSystemTime(new Date('2026-08-28T10:00:00Z'));
      enqueue(report('fp-day-4', { fromPage: true }));
      await settled();
      expect(fetchMock.mock.calls).toHaveLength(5);
      const policy = await readPolicy();
      expect(policy.day).toBe('2026-08-28');
      expect(policy.page).toBe(1);
      expect(policy.noticeSent).toEqual({}); // the notice can fire again tomorrow
      expect(policy.occurrences).toEqual({ 'fp-day-4': 1 }); // the ladder restarted
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the reporting gates', () => {
  it('drops the backlog rather than holding it when the user has reporting off', async () => {
    consent.enabled = false;
    enqueue(report('fp-disabled'));
    await settled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readQueue()).toHaveLength(0); // dropped, not accumulated for a grant that needs a click
  });

  it('sends with credentials omitted and no Content-Type (the CORS-simple sendBeacon shape)', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    enqueue(report('fp-shape'));
    await settled();
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    // `credentials: 'omit'` is mandatory: a collector on a dmarket subdomain is inside the scope of
    // `dm_did` AND `dm-trade-token`; the device id travels as a payload field, never as the jar.
    expect(init.credentials).toBe('omit');
    expect(init.headers).toBeUndefined();
    expect(init.method).toBe('POST');
  });
});
