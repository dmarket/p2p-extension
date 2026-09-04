import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeSettings } from '@/config/settings';
import { subscribeActivation } from '@/state/activation';
import { onStorageChanged } from '@/util/storageEvents';

// These tests model the ORPHANED content script: the extension was reloaded, updated or disabled while a
// page still had our script running in it, so `browser.storage` is gone even though `browser.runtime`
// is still there. See src/util/storageEvents.ts for why that state exists and why it is now routine.
//
// The reported symptom was an uncaught `TypeError: Cannot read properties of undefined (reading
// 'onChanged')` on steamcommunity.com/…/tradeoffers, thrown out of the invalidation handler that
// unsubscribes the settings snapshot — i.e. from the TEARDOWN, which is the case named below.

/** Model a dead extension context by removing the permission-gated namespace, as the browser does. */
function killStorageNamespace(): void {
  const target = browser as unknown as Record<string, unknown>;
  const original = target.storage;
  restore = () => {
    target.storage = original;
  };
  target.storage = undefined;
}

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('the storage.onChanged registrar', () => {
  it('delivers changes and stops on unsubscribe while the context is alive', async () => {
    const seen: unknown[] = [];
    const unsubscribe = onStorageChanged((changes, area) => {
      seen.push([Object.keys(changes), area]);
    });

    await browser.storage.local.set({ probe: 1 });
    expect(seen).toEqual([[['probe'], 'local']]);

    unsubscribe();
    await browser.storage.local.set({ probe: 2 });
    expect(seen).toHaveLength(1);
  });

  it('subscribes to nothing, without throwing, on an already-dead context', () => {
    killStorageNamespace();

    let unsubscribe: () => void = () => {};
    expect(() => {
      unsubscribe = onStorageChanged(() => {});
    }).not.toThrow();
    // Nothing to undo, and undoing it must not throw either — this is the invalidation-handler path.
    expect(() => unsubscribe()).not.toThrow();
  });

  it('unsubscribes without throwing when the context dies mid-flight (the reported failure)', () => {
    const unsubscribe = onStorageChanged(() => {});
    killStorageNamespace();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('swallows a removeListener that throws on dead bindings', () => {
    vi.spyOn(browser.storage.onChanged, 'removeListener').mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    const unsubscribe = onStorageChanged(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });
});

describe('the mirrors built on it', () => {
  // Both registrars in the codebase go through onStorageChanged; these pin that they really do, since a
  // reintroduced `browser.storage.onChanged.addListener` call would compile and pass every other test.
  it('subscribeSettings neither subscribes nor throws on a dead context', () => {
    killStorageNamespace();
    let unsubscribe: () => void = () => {};
    expect(() => {
      unsubscribe = subscribeSettings();
    }).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('subscribeActivation neither subscribes nor throws on a dead context', () => {
    killStorageNamespace();
    let unsubscribe: () => void = () => {};
    expect(() => {
      unsubscribe = subscribeActivation(() => {});
    }).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();
  });
});
