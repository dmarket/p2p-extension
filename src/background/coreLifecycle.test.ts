import { describe, expect, it, vi } from 'vitest';
import { createCoreLifecycle, type CoreLifecycleDeps } from '@/background/coreLifecycle';

// The reconciler is the whole of the activation gate: an un-activated install must never get a core, and
// the two callers that can ask for one (the boot, and the user flipping the flag) race routinely in MV3.

/** A fake background: `running` stands in for the real `handle !== undefined`. */
function harness(activated: boolean) {
  const state = { activated, running: false };
  const start = vi.fn((force: boolean) => {
    state.running = true;
    return force;
  });
  const stop = vi.fn(() => {
    state.running = false;
  });
  const forceHeartbeat = vi.fn();
  const onError = vi.fn();
  const isActivated = vi.fn(() => Promise.resolve(state.activated));
  const deps: CoreLifecycleDeps = {
    isActivated,
    isRunning: () => state.running,
    start,
    stop,
    forceHeartbeat,
    onError,
  };
  return { state, start, stop, forceHeartbeat, onError, isActivated, lifecycle: createCoreLifecycle(deps) };
}

describe('the core runs iff the extension is activated', () => {
  it('starts no core for an install that was never activated', async () => {
    const h = harness(false);

    await h.lifecycle.reconcile();

    expect(h.start).not.toHaveBeenCalled();
    expect(h.state.running).toBe(false);
  });

  it('withdraws on every inactive pass, even with no core to tear down', async () => {
    // The spawn that finds the flag ALREADY false is the one case where nobody else will: the pass that
    // saw it change never ran, because the worker was evicted before it. Skipping the withdrawal there
    // strands the last session's blocking reason, which outranks NOT_ACTIVATED on every surface — the
    // Steam page then shows the wrong-account banner instead of the Activate one the user needs.
    const h = harness(false);

    await h.lifecycle.reconcile();

    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it('starts one for an activated install', async () => {
    const h = harness(true);

    await h.lifecycle.reconcile();

    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('stops the running core when the flag goes off', async () => {
    const h = harness(true);
    await h.lifecycle.reconcile();

    h.state.activated = false;
    await h.lifecycle.reconcile();

    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.state.running).toBe(false);
  });

  it('does not restart a core that already matches the flag', async () => {
    const h = harness(true);
    await h.lifecycle.reconcile();
    h.start.mockClear();

    await h.lifecycle.reconcile();
    await h.lifecycle.reconcile();

    // A reconcile is not a restart: the one caller that wants one tears the core down first.
    expect(h.start).not.toHaveBeenCalled();
    expect(h.stop).not.toHaveBeenCalled();
    // And an unforced pass owes nothing, so it must not nudge a core that is running to schedule.
    expect(h.forceHeartbeat).not.toHaveBeenCalled();
  });

  it('reads the flag fresh on every pass rather than caching the first answer', async () => {
    const h = harness(false);
    await h.lifecycle.reconcile();

    h.state.activated = true;
    await h.lifecycle.reconcile();

    expect(h.start).toHaveBeenCalledTimes(1);
  });
});

describe('concurrent reconciles', () => {
  it('never starts two cores when the boot and the flag subscription race', async () => {
    const h = harness(true);

    // The MV3 norm: writing the flag wakes a worker, so the spawn that boots is often the one delivering
    // the change. Both call in the same tick, neither has read the flag yet.
    await Promise.all([h.lifecycle.reconcile(), h.lifecycle.reconcile({ force: true })]);

    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('carries a forced heartbeat through a pass that absorbed it', async () => {
    const h = harness(true);

    // The plain boot reconcile is queued first; the activation's forced one is absorbed into it. The user
    // pressed Activate, so the heartbeat must still be forced — otherwise they stay absent for up to a ttl.
    await Promise.all([h.lifecycle.reconcile(), h.lifecycle.reconcile({ force: true })]);

    expect(h.start).toHaveBeenCalledWith(true);
  });

  it('does not force on an ordinary boot, so a respawn inside a live ttl still idles', async () => {
    const h = harness(true);

    await h.lifecycle.reconcile();

    expect(h.start).toHaveBeenCalledWith(false);
  });

  it('runs a fresh pass for a flip that lands while a pass is in flight', async () => {
    const h = harness(false);
    // Held open so the first pass can be caught mid-read, with the resolver in hand before anything runs.
    let release!: (activated: boolean) => void;
    const held = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    h.isActivated.mockReturnValueOnce(held);

    const first = h.lifecycle.reconcile();
    // Let the first pass start and reach its `await`. Only now is it past the point where a later caller
    // could be absorbed into it — this one has to queue a pass of its own, or the flip below is lost.
    await Promise.resolve();
    await Promise.resolve();
    h.state.activated = true;
    const second = h.lifecycle.reconcile({ force: true });
    release(false); // the in-flight pass reads the value from before the flip
    await Promise.all([first, second]);

    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.state.running).toBe(true);
  });

  it('still forces the heartbeat when an earlier unforced pass already started the core', async () => {
    // The shape that loses it: the activation write WAKES an evicted worker, so that worker's own boot
    // reconcile reads the already-true flag and starts unforced, and the subscription's forced pass then
    // arrives to find a core running. Returning there would leave the user who just pressed Activate on
    // whatever the persisted schedule says — absent for up to a full backend ttl, which is the gap `force`
    // exists to close.
    const h = harness(true);
    await h.lifecycle.reconcile();
    expect(h.start).toHaveBeenCalledWith(false);

    await h.lifecycle.reconcile({ force: true });

    expect(h.start).toHaveBeenCalledTimes(1);
    expect(h.forceHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('forces once, not twice, when the start itself was already forced', async () => {
    const h = harness(true);

    await h.lifecycle.reconcile({ force: true });

    expect(h.start).toHaveBeenCalledWith(true);
    expect(h.forceHeartbeat).not.toHaveBeenCalled();
  });

  it('never forces a heartbeat on a core it just refused to run', async () => {
    const h = harness(false);

    await h.lifecycle.reconcile({ force: true });

    expect(h.forceHeartbeat).not.toHaveBeenCalled();
    expect(h.start).not.toHaveBeenCalled();
  });

  it('settles on the LAST value when the flag is flipped twice in a burst', async () => {
    const h = harness(true);
    await h.lifecycle.reconcile();

    h.state.activated = false;
    const off = h.lifecycle.reconcile();
    h.state.activated = true;
    const on = h.lifecycle.reconcile();
    await Promise.all([off, on]);

    expect(h.state.running).toBe(true);
  });
});

describe('failures never poison the chain', () => {
  it('reports a rejected flag read and keeps reconciling afterwards', async () => {
    const h = harness(true);
    const boom = new Error('storage unavailable');
    h.isActivated.mockRejectedValueOnce(boom);

    await h.lifecycle.reconcile();
    expect(h.onError).toHaveBeenCalledWith(boom);
    expect(h.start).not.toHaveBeenCalled();

    // The chain is the one thing a rejection could break for good: every later pass awaits it.
    await h.lifecycle.reconcile();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  it('stops a RUNNING core when the flag read rejects', async () => {
    // The read that rejects may well be the pass handling a deactivation. Leaving the core up then keeps
    // it heartbeating and writing to Steam after the user asked it to stop, until some later pass
    // notices — so an unreadable flag is treated as absent consent, not as "carry on".
    const h = harness(true);
    await h.lifecycle.reconcile();
    expect(h.state.running).toBe(true);

    h.isActivated.mockRejectedValueOnce(new Error('storage unavailable'));
    await h.lifecycle.reconcile();

    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(h.state.running).toBe(false);
  });

  it('settles OFF and stays there while the flag stays unreadable', async () => {
    const h = harness(true);
    h.isActivated.mockRejectedValue(new Error('storage unavailable'));

    await h.lifecycle.reconcile();
    await h.lifecycle.reconcile();

    expect(h.start).not.toHaveBeenCalled();
    expect(h.state.running).toBe(false);
  });
});
