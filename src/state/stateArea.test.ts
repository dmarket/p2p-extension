import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// STATE_AREA is decided at import time, so each test stubs the context first and imports fresh modules.
async function asContentScript(firefox: boolean) {
  vi.stubGlobal('location', { protocol: 'https:' });
  vi.stubEnv('FIREFOX', firefox ? 'true' : '');
  vi.resetModules();
  return {
    area: (await import('@/state/stateArea')).STATE_AREA,
    activation: await import('@/state/activation'),
    blocking: await import('@/state/blocking'),
  };
}

describe('state area in a content script', () => {
  beforeEach(() => fakeBrowser.reset());

  it('asks the worker on Chrome and never reads either storage area', async () => {
    const { area, activation, blocking } = await asContentScript(false);
    expect(area).toBe('mirror');
    await fakeBrowser.storage.local.set({ 'activation.enabled': true, 'tracker.blockingReason': 'DM_SESSION_MISSING' });
    await fakeBrowser.storage.session.set({ 'activation.enabled': true, 'tracker.blockingReason': 'DM_SESSION_MISSING' });
    const ask = vi.spyOn(fakeBrowser.runtime, 'sendMessage') as unknown as ReturnType<typeof vi.fn>;
    ask.mockResolvedValue(undefined);
    expect(await activation.readActivation()).toBeUndefined(); // no answer: wait, do not onboard
    ask.mockResolvedValue({ 'activation.enabled': false, 'tracker.blockingReason': 'NONE' });
    expect(await activation.readActivation()).toBe(false);
    expect(await blocking.getBlockingReason()).toBe('NONE');
    expect(ask).toHaveBeenCalledWith({ kind: 'state:get', keys: ['tracker.blockingReason'] });
    ask.mockRejectedValue(new Error('Extension context invalidated.'));
    expect(await activation.readActivation()).toBeUndefined();
  });

  it('follows changes the worker pushes, not storage', async () => {
    const { activation } = await asContentScript(false);
    const seen: boolean[] = [];
    activation.subscribeActivation((v) => seen.push(v));
    await fakeBrowser.storage.local.set({ 'activation.enabled': true });
    await fakeBrowser.storage.session.set({ 'activation.enabled': true });
    // Typed as an array, but the fake returns a promise (see background/router.test.ts).
    await (fakeBrowser.runtime.onMessage.trigger(
      { kind: 'state:changed', changes: { 'activation.enabled': { newValue: true } } },
      { id: fakeBrowser.runtime.id },
      () => {},
    ) as unknown as Promise<unknown>);
    expect(seen).toEqual([true]);
  });

  it('keeps reading storage.local on Firefox', async () => {
    const { area, activation } = await asContentScript(true);
    expect(area).toBe('local');
    await fakeBrowser.storage.local.set({ 'activation.enabled': true });
    expect(await activation.readActivation()).toBe(true);
  });
});
