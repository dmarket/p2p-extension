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

export type StorageChangedListener = (
  changes: Record<string, Browser.storage.StorageChange>,
  area: Browser.storage.AreaName,
) => void;

/** Register `listener` for storage changes in any area. Returns an unsubscribe that cannot throw. */
export function onStorageChanged(listener: StorageChangedListener): () => void {
  // The types say this is always there; an orphaned content script is exactly the state where it is not.
  const events = browser.storage?.onChanged;
  if (!events) return () => {};
  events.addListener(listener);
  return () => {
    try {
      events.removeListener(listener);
    } catch {
      /* the context died between subscribe and teardown — there is nothing left to unsubscribe from */
    }
  };
}
