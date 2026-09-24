import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// The forced update in one place: what the pong says, and when Chrome is asked. The rule of the design is that
// the extension never calls `requestUpdateCheck()` unless it is below the minimum, calls it once per rule, and
// re-asks only on a completed config fetch.

type Module = typeof import('@/background/forceUpdate');
type Check = { status: string; version?: string };

let mod: Module;

// Module state (the single-flight promises in forceUpdate.ts and update.ts) must not leak between tests.
beforeEach(async () => {
  vi.resetModules();
  mod = await import('@/background/forceUpdate');
});

function setup(own: string, answers: Check[] | (() => Promise<Check>)) {
  const reload = vi.fn();
  const queue = Array.isArray(answers) ? [...answers] : undefined;
  const requestUpdateCheck = vi.fn(
    queue ? () => Promise.resolve(queue.shift() ?? { status: 'throttled' }) : (answers as () => Promise<Check>),
  );
  mod.registerForceUpdate({
    isBusy: () => false,
    reload,
    sleep: () => Promise.resolve(),
    ownVersion: () => own,
    requestUpdateCheck,
  });
  return { reload, requestUpdateCheck };
}

/** Let the fire-and-forget reload chain (`scheduleUpdate`) run to its end. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('without a rule to act on', () => {
  it('reports nothing required and never asks Chrome, with no minimum known yet', async () => {
    const { requestUpdateCheck } = setup('1.0.6', []);

    await mod.evaluateForceUpdate(undefined, { recheck: true });

    expect(requestUpdateCheck).not.toHaveBeenCalled();
    expect(await mod.getUpdateStatus(undefined)).toEqual({ required: false, state: 'none' });
  });

  it('reports nothing required and never asks Chrome when the build is at or above the minimum', async () => {
    const { requestUpdateCheck } = setup('1.0.6', []);

    await mod.evaluateForceUpdate('1.0.6', { recheck: true });
    await mod.evaluateForceUpdate('1.0.5', { recheck: true });

    expect(requestUpdateCheck).not.toHaveBeenCalled();
    expect(await mod.getUpdateStatus('1.0.6')).toEqual({ required: false, minVersion: '1.0.6', state: 'none' });
  });

  it('compares the numeric part: 1.0.10 is above 1.0.9', async () => {
    const { requestUpdateCheck } = setup('1.0.10', []);
    await mod.evaluateForceUpdate('1.0.9');
    expect(requestUpdateCheck).not.toHaveBeenCalled();
  });
});

describe('below the minimum', () => {
  it('says `checking` before the first answer, then `applying` and reloads when Chrome has the update', async () => {
    const { reload, requestUpdateCheck } = setup('1.0.5', [{ status: 'update_available', version: '1.0.7' }]);
    expect(await mod.getUpdateStatus('1.0.7')).toEqual({ required: true, minVersion: '1.0.7', state: 'checking' });

    await mod.evaluateForceUpdate('1.0.7');
    await settle();

    expect(requestUpdateCheck).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect((await mod.getUpdateStatus('1.0.7')).state).toBe('applying');
    // The same pending mark `onUpdateAvailable` writes, so an evicted worker still finishes the reload.
    expect(await fakeBrowser.storage.session.get('update.pendingVersion')).toEqual({
      'update.pendingVersion': '1.0.7',
    });
  });

  it.each(['no_update', 'throttled'])('says `restart_required` on `%s`', async (status) => {
    setup('1.0.5', [{ status }]);
    await mod.evaluateForceUpdate('1.0.7');
    expect(await mod.getUpdateStatus('1.0.7')).toEqual({
      required: true,
      minVersion: '1.0.7',
      state: 'restart_required',
    });
  });

  it('says `restart_required` when the API itself fails', async () => {
    setup('1.0.5', () => Promise.reject(new Error('updater disabled')));
    await mod.evaluateForceUpdate('1.0.7');
    expect((await mod.getUpdateStatus('1.0.7')).state).toBe('restart_required');
  });

  it('asks once per rule on spawns and settings reloads, and again on each completed fetch', async () => {
    const { requestUpdateCheck } = setup('1.0.5', [{ status: 'no_update' }, { status: 'throttled' }]);

    await mod.evaluateForceUpdate('1.0.7');
    await mod.evaluateForceUpdate('1.0.7');
    expect(requestUpdateCheck).toHaveBeenCalledTimes(1);

    await mod.evaluateForceUpdate('1.0.7', { recheck: true });
    expect(requestUpdateCheck).toHaveBeenCalledTimes(2);
  });

  it('keeps `restart_required` across a worker respawn without asking again', async () => {
    setup('1.0.5', [{ status: 'no_update' }]);
    await mod.evaluateForceUpdate('1.0.7');

    vi.resetModules();
    mod = await import('@/background/forceUpdate');
    const { requestUpdateCheck } = setup('1.0.5', []);
    await mod.evaluateForceUpdate('1.0.7');

    expect(requestUpdateCheck).not.toHaveBeenCalled();
    expect((await mod.getUpdateStatus('1.0.7')).state).toBe('restart_required');
  });

  it('re-runs a check an evicted worker left at `checking`', async () => {
    await fakeBrowser.storage.session.set({ 'update.forced': { min: '1.0.7', state: 'checking' } });
    const { requestUpdateCheck } = setup('1.0.5', [{ status: 'no_update' }]);

    await mod.evaluateForceUpdate('1.0.7');

    expect(requestUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('treats a raised minimum as a new rule', async () => {
    const { requestUpdateCheck } = setup('1.0.5', [{ status: 'no_update' }, { status: 'no_update' }]);
    await mod.evaluateForceUpdate('1.0.6');
    await mod.evaluateForceUpdate('1.0.7');
    expect(requestUpdateCheck).toHaveBeenCalledTimes(2);
  });

  it('asks once when a spawn and a fetch land together', async () => {
    const { requestUpdateCheck } = setup('1.0.5', [{ status: 'no_update' }]);
    await Promise.all([mod.evaluateForceUpdate('1.0.7'), mod.evaluateForceUpdate('1.0.7', { recheck: true })]);
    expect(requestUpdateCheck).toHaveBeenCalledTimes(1);
  });

  it('forgets the state once the rule no longer applies', async () => {
    setup('1.0.5', [{ status: 'no_update' }]);
    await mod.evaluateForceUpdate('1.0.7');
    await mod.evaluateForceUpdate('1.0.5');
    expect(await fakeBrowser.storage.session.get('update.forced')).toEqual({});
  });

  it('says `applying` while an update Chrome announced by itself is waiting for a proof', async () => {
    let busy = true;
    const update = await import('@/background/update');
    setup('1.0.5', []);
    const pending = update.applyWhenIdle({ isBusy: () => busy, reload: vi.fn(), sleep: () => settle() }, '1.0.7');

    expect((await mod.getUpdateStatus('1.0.7')).state).toBe('applying');
    busy = false;
    await pending;
  });
});
