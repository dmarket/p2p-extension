import { describe, expect, it, vi } from 'vitest';
import {
  BLOCKING_KEY,
  getBlockingReason,
  getLinkedSteamId,
  setBlockingReason,
  setLinkedSteamId,
  subscribeBlockingReason,
  subscribeLinkedSteamId,
} from '@/state/blocking';
import {
  getActiveTrackingCount,
  setActiveTrackingCount,
  subscribeActiveTrackingCount,
} from '@/state/activeCount';
import { flushMacrotasks } from '@/testing/stubs';

// The storage mirrors between the service worker and the UI surfaces. Deliberately NOT the reason
// vocabulary or its priority — those are owned by scripts/check-surface-priority.mjs (run by `npm run
// compile` against the INSTALLED core). What the guard cannot check is the storage behaviour: the
// read-compare-write discipline, deletion semantics, and the legacy-value migration as an integration
// through a real subscriber.

/** Counts real storage.onChanged deliveries for a key while `fn` runs. */
async function onChangedEvents(fn: () => Promise<void>): Promise<number> {
  const seen = vi.fn();
  const listener = (): void => {
    seen();
  };
  browser.storage.onChanged.addListener(listener);
  await fn();
  await flushMacrotasks();
  browser.storage.onChanged.removeListener(listener);
  return seen.mock.calls.length;
}

describe('the blocking-reason mirror', () => {
  it('reads NONE when nothing is stored', async () => {
    await expect(getBlockingReason()).resolves.toBe('NONE');
  });

  it('round-trips a core reason', async () => {
    await setBlockingReason('STEAM_SESSION_MISSING');
    await expect(getBlockingReason()).resolves.toBe('STEAM_SESSION_MISSING');
  });

  it('is read-compare-write: an unchanged reason fires NO onChanged event', async () => {
    // The frequent callers (every heartbeat event, every presence poll) re-mirror deliberately without
    // an in-memory dedupe; this is the property that keeps that from being an onChanged storm.
    await setBlockingReason('DM_SESSION_MISSING');
    const events = await onChangedEvents(() => setBlockingReason('DM_SESSION_MISSING'));
    expect(events).toBe(0);
    const changed = await onChangedEvents(() => setBlockingReason('NONE'));
    expect(changed).toBe(1);
  });

  it('surfaces a LEGACY stored value to a subscriber under its renamed reason', async () => {
    // An updated install still holds the pre-rename value in storage.local; the seam's alias map is what
    // keeps it from failing closed to UNKNOWN. Integration through a real subscriber rather than a
    // mapping table — the table itself is guard-owned.
    const seen: string[] = [];
    const unsubscribe = subscribeBlockingReason((r) => seen.push(r));
    await browser.storage.local.set({ [BLOCKING_KEY]: 'MISSING_CONNECTION' });
    await vi.waitFor(() => expect(seen).toEqual(['DM_SESSION_MISSING']));
    await expect(getBlockingReason()).resolves.toBe('DM_SESSION_MISSING');
    unsubscribe();
  });

  it('fails closed on an unrecognised stored value', async () => {
    await browser.storage.local.set({ [BLOCKING_KEY]: 'SOME_FUTURE_CORE_STATE' });
    await expect(getBlockingReason()).resolves.toBe('UNKNOWN');
  });

  it('a deletion reaches a subscriber as NONE (the parse sees newValue === undefined)', async () => {
    await setBlockingReason('DM_CONNECTION_ERROR');
    const seen: string[] = [];
    const unsubscribe = subscribeBlockingReason((r) => seen.push(r));
    await browser.storage.local.remove(BLOCKING_KEY);
    await vi.waitFor(() => expect(seen).toEqual(['NONE']));
    unsubscribe();
  });
});

describe('the linked-Steam-id mirror', () => {
  it('round-trips, clears with undefined, and treats blank/non-string as unknown', async () => {
    await setLinkedSteamId('76561198338780301');
    await expect(getLinkedSteamId()).resolves.toBe('76561198338780301');
    await setLinkedSteamId(undefined);
    await expect(getLinkedSteamId()).resolves.toBeUndefined();
    await browser.storage.local.set({ 'tracker.linkedSteamId': '' });
    await expect(getLinkedSteamId()).resolves.toBeUndefined();
    await browser.storage.local.set({ 'tracker.linkedSteamId': 765 });
    await expect(getLinkedSteamId()).resolves.toBeUndefined();
  });

  it('is read-compare-write for both set and clear', async () => {
    await setLinkedSteamId('76561198338780301');
    expect(await onChangedEvents(() => setLinkedSteamId('76561198338780301'))).toBe(0);
    await setLinkedSteamId(undefined);
    expect(await onChangedEvents(() => setLinkedSteamId(undefined))).toBe(0);
  });

  it('a clear reaches a subscriber as undefined', async () => {
    await setLinkedSteamId('76561198338780301');
    const seen: (string | undefined)[] = [];
    const unsubscribe = subscribeLinkedSteamId((id) => seen.push(id));
    await setLinkedSteamId(undefined);
    await vi.waitFor(() => expect(seen).toEqual([undefined]));
    unsubscribe();
  });
});

describe('the active-tracking-count mirror (session storage)', () => {
  it('reads 0 when nothing is stored, floors fractions, and rejects malformed values', async () => {
    await expect(getActiveTrackingCount()).resolves.toBe(0);
    await setActiveTrackingCount(2.9);
    await expect(getActiveTrackingCount()).resolves.toBe(2);
    for (const bad of ['3', NaN, -1, Infinity]) {
      await browser.storage.session.set({ 'tracker.activeTrackingCount': bad });
      await expect(getActiveTrackingCount()).resolves.toBe(0);
    }
  });

  it('lives in session storage, not local', async () => {
    // `session` is the deliberate choice: it survives SW respawns but clears on browser restart, so a
    // stale count from a previous session is never surfaced. A silent move to `local` would pass every
    // other test here.
    await setActiveTrackingCount(4);
    const local = await browser.storage.local.get('tracker.activeTrackingCount');
    expect(local['tracker.activeTrackingCount']).toBeUndefined();
  });

  it('is read-compare-write and delivers changes to a subscriber', async () => {
    await setActiveTrackingCount(4);
    expect(await onChangedEvents(() => setActiveTrackingCount(4))).toBe(0);
    const seen: number[] = [];
    const unsubscribe = subscribeActiveTrackingCount((n) => seen.push(n));
    await setActiveTrackingCount(5);
    await vi.waitFor(() => expect(seen).toEqual([5]));
    unsubscribe();
  });
});
