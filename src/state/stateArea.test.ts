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

  it('reads the session mirror on Chrome, never storage.local', async () => {
    const { area, activation, blocking } = await asContentScript(false);
    expect(area).toBe('session');
    await fakeBrowser.storage.local.set({ 'activation.enabled': true, 'tracker.blockingReason': 'DM_SESSION_MISSING' });
    expect(await activation.readActivation()).toBeUndefined(); // mirror not written yet: wait, do not onboard
    await fakeBrowser.storage.session.set({ 'activation.enabled': false, 'tracker.blockingReason': 'NONE' });
    expect(await activation.readActivation()).toBe(false);
    expect(await blocking.getBlockingReason()).toBe('NONE');
  });

  it('follows changes to the session mirror', async () => {
    const { activation } = await asContentScript(false);
    const seen: boolean[] = [];
    activation.subscribeActivation((v) => seen.push(v));
    await fakeBrowser.storage.local.set({ 'activation.enabled': true });
    await fakeBrowser.storage.session.set({ 'activation.enabled': true });
    expect(seen).toEqual([true]);
  });

  it('keeps reading storage.local on Firefox', async () => {
    const { area, activation } = await asContentScript(true);
    expect(area).toBe('local');
    await fakeBrowser.storage.local.set({ 'activation.enabled': true });
    expect(await activation.readActivation()).toBe(true);
  });
});
