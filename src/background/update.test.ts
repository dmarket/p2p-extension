import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { applyWhenIdle, registerUpdateReload, resumePendingUpdate } from '@/background/update';
import { getSettings } from '@/config/settings';

// A parked update is applied by reloading the extension. These pin WHEN: not while a proof is running, never
// later than the proof deadline allows, and still after the worker that heard the event was evicted.

const PENDING_KEY = 'update.pendingVersion';

/** A clock that only moves when the code under test sleeps, so the wait is exact and instant. */
function fakeTime() {
  let t = 0;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
  };
}

describe('applying a parked update', () => {
  it('reloads at once when no proof is running', async () => {
    const reload = vi.fn();

    await applyWhenIdle({ isBusy: () => false, reload, ...fakeTime() }, '1.0.6');

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('waits for the running proof to finish, then reloads', async () => {
    const reload = vi.fn();
    const time = fakeTime();
    const busyUntil = 10_000;

    await applyWhenIdle({ isBusy: () => time.now() < busyUntil, reload, ...time }, '1.0.6');

    expect(reload).toHaveBeenCalledTimes(1);
    expect(time.now()).toBeGreaterThanOrEqual(busyUntil);
  });

  it('does not let a proof that never ends pin the old build: it reloads at the proof deadline', async () => {
    const reload = vi.fn();
    const time = fakeTime();
    const cap = getSettings().web.notaryProofTimeoutMs;

    await applyWhenIdle({ isBusy: () => true, reload, ...time }, '1.0.6');

    expect(reload).toHaveBeenCalledTimes(1);
    expect(time.now()).toBeGreaterThanOrEqual(cap);
    // Bounded by the deadline plus its margin, not open-ended.
    expect(time.now()).toBeLessThan(cap + 60_000);
  });

  it('reloads once when the event and a resume race', async () => {
    const reload = vi.fn();
    const deps = { isBusy: () => false, reload, ...fakeTime() };

    await Promise.all([applyWhenIdle(deps, '1.0.6'), applyWhenIdle(deps, '1.0.6')]);

    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('the onUpdateAvailable listener', () => {
  it('records the pending version and reloads', async () => {
    const reload = vi.fn();
    registerUpdateReload({ isBusy: () => false, reload, ...fakeTime() });

    await fakeBrowser.runtime.onUpdateAvailable.trigger({ version: '1.0.6' });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));

    expect((await fakeBrowser.storage.session.get(PENDING_KEY))[PENDING_KEY]).toBe('1.0.6');
  });
});

describe('resuming after the worker was evicted', () => {
  it('reloads when an earlier worker left an update pending', async () => {
    await fakeBrowser.storage.session.set({ [PENDING_KEY]: '1.0.6' });
    const reload = vi.fn();

    await resumePendingUpdate({ isBusy: () => false, reload, ...fakeTime() });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no update is pending', async () => {
    const reload = vi.fn();

    await resumePendingUpdate({ isBusy: () => false, reload, ...fakeTime() });

    expect(reload).not.toHaveBeenCalled();
  });
});
