// The one place `browser.storage.onChanged` is registered — because in a content script that listener
// can outlive its own extension context.
//
// Reloading, updating or disabling the extension ORPHANS every content script already running in a page.
// `browser.runtime` survives the orphaning (with `id` undefined, which is what WXT's `ctx.isInvalid`
// keys on) but the permission-gated namespaces do not: `browser.storage` reads back `undefined`. Every
// `browser.storage.onChanged.…` in an orphaned script is therefore a TypeError, and the worst place it
// lands is the teardown that invalidation itself runs — `ctx.onInvalidated` handlers are abort listeners
// on a DOM signal, so nothing catches the throw (it surfaces as an uncaught TypeError on the page) and
// anything queued behind it in the same handler never runs.
//
// That path used to be rare, because an orphaned script only ever noticed its own death lazily. It is
// routine now that src/background/inject-content-scripts.ts re-injects on install/update: the fresh
// instance's start-up announcement invalidates the orphan immediately, on every update, in every tab.
//
// So both directions fail soft. Subscribing on a dead context is a no-op — there is no update left to
// deliver, since the listener could never fire again — and unsubscribing never throws, because a
// teardown that must not fail should not be able to.
//
// In a Chrome content script the mirrored keys do not come from storage at all (src/state/stateArea.ts): the
// worker pushes their changes by message, and they are delivered here as area `'mirror'`.

import { isStateChanged, STATE_AREA, type StateAreaName } from '@/state/stateArea';

export type StorageChangedListener = (
  changes: Record<string, Browser.storage.StorageChange>,
  area: Browser.storage.AreaName | StateAreaName,
) => void;

/** Register `listener` for storage changes in any area. Returns an unsubscribe that cannot throw. */
export function onStorageChanged(listener: StorageChangedListener): () => void {
  const removers = [subscribe(browser.storage?.onChanged, listener)];
  if (STATE_AREA === 'mirror') {
    removers.push(
      subscribe(browser.runtime?.onMessage, (message: unknown) => {
        if (isStateChanged(message)) listener(message.changes, 'mirror');
        return undefined;
      }),
    );
  }
  return () => removers.forEach((remove) => remove());
}

interface Events<L> {
  addListener(listener: L): void;
  removeListener(listener: L): void;
}

function subscribe<L>(events: Events<L> | undefined, listener: L): () => void {
  // The types say this is always there; an orphaned content script is exactly the state where it is not.
  if (!events) return () => {};
  try {
    events.addListener(listener);
  } catch {
    return () => {};
  }
  return () => {
    try {
      events.removeListener(listener);
    } catch {
      /* the context died between subscribe and teardown — there is nothing left to unsubscribe from */
    }
  };
}
