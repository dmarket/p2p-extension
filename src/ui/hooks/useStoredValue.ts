import { useEffect, useState } from 'preact/hooks';

/**
 * The one hook behind every `use*` in this directory: read a mirrored storage value once, then keep it
 * live through that mirror's `subscribe*` (see src/state/).
 *
 * The `live` flag is not ceremony — the initial read is async, so without it a component unmounted
 * mid-read (the popup closes on every CTA, which calls `tabs.create`) would set state after teardown.
 *
 * `pushed` fixes a race each hand-rolled copy of this had: a `storage.onChanged` update that lands while
 * the initial read is still in flight is NEWER than that read, so the read must not overwrite it.
 *
 * `initial` is part of each caller's contract, not a detail: the three `undefined`-initial hooks are what
 * let the popup and the Steam banner render a deliberate loading state instead of flashing the wrong
 * screen, while the count's `0` is a real empty state that needs no loading branch.
 */
export function useStoredValue<T>(
  read: () => Promise<T>,
  subscribe: (onChange: (value: T) => void) => () => void,
  initial: T,
): T {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    let live = true;
    let pushed = false;
    const unsubscribe = subscribe((next) => {
      pushed = true;
      setValue(next);
    });
    void read()
      .then((next) => {
        if (live && !pushed) setValue(next);
      })
      // The other half of what src/util/storageEvents.ts absorbs: this effect can first run in a context
      // that has ALREADY been orphaned (the entrypoint re-checks `ctx.isInvalid` right before mounting,
      // but Preact flushes effects a tick later, and a re-injected instance invalidates us in between).
      // `browser.storage.local` is gone by then, so the read rejects — and without this it rejects into
      // nobody, as an uncaught promise on the page. Staying at `initial` is the honest outcome: for the
      // three `undefined`-initial hooks that is the loading state, and the tree is about to be unmounted.
      .catch(() => {});
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);

  return value;
}
