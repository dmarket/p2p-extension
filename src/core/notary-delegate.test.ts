import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createNotaryProofDelegate, supportsOffscreenProver } from '@/core/notary-delegate';
import { proofsInFlight, setNotaryTraceSink } from '@/core/notary-trace';
import type { NotaryProveMessage, NotaryProveReply } from '@/core/notary-messages';

// The proof deadline and the proving-context lifecycle — the port of the deleted timeout smoke (which was
// proven sensitive: 15/18 failing with the two fixes reverted). The two regressions by name:
//  - `ensureOffscreenDocument` used to be awaited OUTSIDE the deadline, and neither `getContexts` nor
//    `createDocument` rejects when it simply never settles — the one hang the bound did not cover;
//  - a hung `createDocument` pinned the memoised `creating` promise forever (its `.finally` never runs),
//    so after one hung create EVERY later proof awaited the same dead promise.

const REQUEST_JSON = JSON.stringify({
  dealId: 'deal-1',
  source: 'OFFER',
  steamOfferId: '9313246543',
});

interface Stubs {
  createDocument: ReturnType<typeof vi.fn>;
  closeDocument: ReturnType<typeof vi.fn>;
  getContexts: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

let stubs: Stubs;
let traces: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  traces = [];
  setNotaryTraceSink((_event, note, level) => traces.push(`${level}: ${note}`));

  // `chrome.offscreen` / `runtime.getContexts` are Chrome-only and absent from the fake — assigned, and
  // torn back down in afterEach (restoreMocks covers only spies on existing functions).
  stubs = {
    createDocument: vi.fn(() => Promise.resolve()),
    closeDocument: vi.fn(() => Promise.resolve()),
    getContexts: vi.fn(() => Promise.resolve([])),
    sendMessage: vi.fn(),
  };
  (fakeBrowser as unknown as Record<string, unknown>).offscreen = {
    createDocument: stubs.createDocument,
    closeDocument: stubs.closeDocument,
  };
  (fakeBrowser.runtime as unknown as Record<string, unknown>).getContexts = stubs.getContexts;
  // Spied through a narrowed view of the property, for the reason spelled out in bridge.test.ts: the runtime
  // namespace's `sendMessage` overload set resolves to the callback form returning `void`, so casting the stub
  // to `typeof fakeBrowser.runtime.sendMessage` declared a void-returning mock — and `no-misused-promises`
  // was right to flag a promise-returning stub behind it. This names the overload the delegate actually calls.
  vi.spyOn(
    fakeBrowser.runtime as unknown as { sendMessage(message: unknown): Promise<unknown> },
    'sendMessage',
  ).mockImplementation(stubs.sendMessage as unknown as (message: unknown) => Promise<unknown>);
});

afterEach(() => {
  delete (fakeBrowser as unknown as Record<string, unknown>).offscreen;
  delete (fakeBrowser.runtime as unknown as Record<string, unknown>).getContexts;
  vi.useRealTimers();
  // Asserted after EVERY case in this file, not in one test of its own: the in-flight latch feeds the
  // console's "a proof is running" pill, so a token leaked on any of the five exit paths below reports a
  // permanent hang on a worker that is idle — and the failure would surface far from the path that caused it.
  expect(proofsInFlight()).toEqual([]);
});

const prove = (): Promise<string> =>
  createNotaryProofDelegate({ notary: { notaryUrl: 'wss://notary.test/' } })(
    REQUEST_JSON,
    'notary-token',
    'steam-token',
  );

const ok = (presentation = 'cHJlc2VudGF0aW9u'): NotaryProveReply => ({ ok: true, presentation });

describe('the happy path', () => {
  it('creates the document once, returns the presentation, and leaves the document WARM', async () => {
    stubs.sendMessage.mockResolvedValue(ok('abc'));
    await expect(prove()).resolves.toBe('abc');
    expect(stubs.createDocument).toHaveBeenCalledTimes(1);
    // A settled proof must not tear the document down — the memoised wasm is the point.
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.closeDocument).not.toHaveBeenCalled();
  });

  it('is in flight WHILE the prover works, and named by deal', async () => {
    // The fact the console had no way to learn. `lastProofOutcome` only ever sees the terminal frame, so for
    // the ~17s a healthy proof takes the header described the PREVIOUS one beside a countdown pinned at 0s.
    const reply = Promise.withResolvers<NotaryProveReply>();
    stubs.sendMessage.mockReturnValue(reply.promise);
    const attempt = prove();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(proofsInFlight()).toHaveLength(1);
    reply.resolve(ok());
    await attempt;
    // …and released, which afterEach re-checks for every other case in this file.
    expect(proofsInFlight()).toEqual([]);
  });

  it('reuses an already-open document', async () => {
    stubs.getContexts.mockResolvedValue([{}]);
    stubs.sendMessage.mockResolvedValue(ok());
    await prove();
    expect(stubs.createDocument).not.toHaveBeenCalled();
  });

  it('carries the config and the per-proof settings knobs in the message', async () => {
    // `stuckAfterMs`/`proofsPerInstance` are read per proof so a remote publish needs no tracker restart;
    // the config travels because the offscreen realm reading getSettings() itself would silently see
    // compiled defaults.
    stubs.sendMessage.mockResolvedValue(ok());
    await prove();
    const message = stubs.sendMessage.mock.calls[0]![0] as NotaryProveMessage;
    expect(message.config.notary?.notaryUrl).toBe('wss://notary.test/');
    expect(message.steamAccessToken).toBe('steam-token');
    expect(message.notaryToken).toBe('notary-token');
    expect(message.stuckAfterMs).toBe(25_000); // compiled defaults, via the live settings snapshot
    expect(message.proofsPerInstance).toBe(5);
  });
});

describe('the deadline', () => {
  it('a never-answering prover rejects at the deadline, names it, and recycles the document', async () => {
    stubs.sendMessage.mockReturnValue(new Promise(() => {}));
    const attempt = prove();
    const failure = expect(attempt).rejects.toThrow('timed out after 180000ms');
    await vi.advanceTimersByTimeAsync(180_000);
    await failure;
    // The teardown is what releases the prover's concurrency permit, the sockets and the wasm — a
    // timeout that merely stopped waiting would turn an obvious wedge into a silent one.
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.closeDocument).toHaveBeenCalledTimes(1);
    expect(traces.some((t) => t.startsWith('error: proof TIMED OUT'))).toBe(true);
  });

  it('a never-settling createDocument is UNDER the deadline (the audit bug)', async () => {
    stubs.createDocument.mockReturnValue(new Promise(() => {}));
    const attempt = prove();
    const failure = expect(attempt).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(180_000);
    await failure;
    expect(stubs.sendMessage).not.toHaveBeenCalled(); // it really was the create that hung
  });

  it('drops the memoised creation after a hung create, so the NEXT proof re-creates (the second bug)', async () => {
    stubs.createDocument.mockReturnValueOnce(new Promise(() => {}));
    const first = prove();
    const firstFailure = expect(first).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(180_000);
    await firstFailure;

    // Pre-fix, this attempt awaited the same dead `creating` promise and timed out in turn.
    stubs.sendMessage.mockResolvedValue(ok('second'));
    await expect(prove()).resolves.toBe('second');
    expect(stubs.createDocument).toHaveBeenCalledTimes(2);
  });
});

describe('failure replies', () => {
  it('a fast ok:false keeps its own error and does NOT recycle the document', async () => {
    stubs.sendMessage.mockResolvedValue({ ok: false, error: 'notary handshake failed' });
    await expect(prove()).rejects.toThrow('notary: notary handshake failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.closeDocument).not.toHaveBeenCalled();
  });

  it('an absent reply (document died mid-proof) is surfaced as itself', async () => {
    stubs.sendMessage.mockResolvedValue(undefined);
    await expect(prove()).rejects.toThrow('offscreen document gave no reply');
  });

  it('a POISONED near-instant failure is a zombie proving context: the DOCUMENT is recycled', async () => {
    // A document left over from before an extension reload still answers getContexts and messages, but
    // its realm can no longer construct the worker — it fails in single-digit ms before any wasm runs.
    // Retrying a worker inside it fails identically, so the recovery is the document's.
    stubs.getContexts.mockResolvedValue([{}]); // "already open" — the zombie's signature
    stubs.sendMessage.mockResolvedValue({ ok: false, error: 'prover worker errored: undefined', poisoned: true });
    await expect(prove()).rejects.toThrow('prover worker errored');
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.closeDocument).toHaveBeenCalledTimes(1);
    expect(traces.some((t) => t.includes('zombie proving context closed'))).toBe(true);
  });

  it('a poisoned failure that took real time is a mid-proof trap: worker-level recovery, document kept', async () => {
    // The reply is settled mid-test, after the clock has advanced — so the stub needs a promise this
    // test still holds the resolver for.
    const reply = Promise.withResolvers<NotaryProveReply>();
    stubs.sendMessage.mockReturnValue(reply.promise);
    const attempt = prove();
    const failure = expect(attempt).rejects.toThrow('memory access out of bounds');
    await vi.advanceTimersByTimeAsync(5_000); // the observed traps ran seconds to minutes
    reply.resolve({ ok: false, error: 'memory access out of bounds', poisoned: true });
    await failure;
    await vi.advanceTimersByTimeAsync(0);
    expect(stubs.closeDocument).not.toHaveBeenCalled();
  });
});

describe('supportsOffscreenProver', () => {
  it('is a capability check on chrome.offscreen', () => {
    expect(supportsOffscreenProver()).toBe(true); // the stub is installed
    delete (fakeBrowser as unknown as Record<string, unknown>).offscreen;
    expect(supportsOffscreenProver()).toBe(false); // Firefox-shaped: no offscreen API
  });
});
