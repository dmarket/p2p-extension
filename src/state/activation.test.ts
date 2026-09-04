import { describe, expect, it, vi } from 'vitest';
import { ACTIVATION_KEY, isActivated, setActivated, subscribeActivation } from '@/state/activation';

// The activation flag is the one piece of state the extension owns outright (the rest is mirrored from
// the core), and it gates the popup screen, the Steam banner and the toolbar icon. It also exercises the
// test harness end to end: `browser` here is auto-imported (no import statement, supplied by unimport)
// and backed by @webext-core/fake-browser, so storage is real in-memory storage and onChanged really fires.

describe('the activation flag', () => {
  it('reads false when nothing is stored', async () => {
    await expect(isActivated()).resolves.toBe(false);
  });

  it('round-trips through storage.local', async () => {
    await setActivated(true);
    await expect(isActivated()).resolves.toBe(true);
    await setActivated(false);
    await expect(isActivated()).resolves.toBe(false);
  });

  it('stores a real boolean, not a string', async () => {
    // The core reads some of its own keys as strings, so the storage editor is type-aware; this key must
    // stay a boolean or `=== true` below silently reads false.
    await setActivated(true);
    const raw = await browser.storage.local.get(ACTIVATION_KEY);
    expect(raw[ACTIVATION_KEY]).toBe(true);
  });

  it('treats any non-true value as not activated', async () => {
    for (const value of ['true', 1, {}, null]) {
      await browser.storage.local.set({ [ACTIVATION_KEY]: value });
      await expect(isActivated()).resolves.toBe(false);
    }
  });

  it('notifies subscribers on change and stops after unsubscribe', async () => {
    const seen = vi.fn();
    const unsubscribe = subscribeActivation(seen);

    await setActivated(true);
    expect(seen).toHaveBeenCalledWith(true);

    await setActivated(false);
    expect(seen).toHaveBeenLastCalledWith(false);

    unsubscribe();
    await setActivated(true);
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('ignores changes to other keys', async () => {
    const seen = vi.fn();
    subscribeActivation(seen);
    await browser.storage.local.set({ 'tracker.blockingReason': 'NONE' });
    expect(seen).not.toHaveBeenCalled();
  });
});
