// One per-key `storage.onChanged` registrar for the three state mirrors in this directory.
//
// Each mirror (activation flag, blocking reason + linked Steam id, active-tracking count) had the same
// listener written out: filter the area, look the key up in `changes`, parse `newValue`, hand it to the
// caller, and return a remover. Only the area, the key and the parser ever differed. The typed
// get/set halves are deliberately NOT folded in — those really do differ (session vs local storage, a
// `remove()` branch for clearing, read-compare-write to avoid an onChanged storm).
//
// The add/remove pair itself lives one level down in src/util/storageEvents.ts, which is what makes
// this safe to call (and to undo) from a content script whose extension context has already died.

import { onStorageChanged } from '@/util/storageEvents';

/**
 * Call `onChange` with the parsed new value whenever `key` changes in `area`. Returns an unsubscribe.
 *
 * `parse` runs on the raw `newValue`, so a deletion (`undefined`) reaches it too and each mirror keeps
 * deciding for itself what an absent value means — `false`, `NONE`, `0`, `undefined`.
 */
export function subscribeKey<T>(
  area: Browser.storage.AreaName,
  key: string,
  parse: (value: unknown) => T,
  onChange: (value: T) => void,
): () => void {
  return onStorageChanged((changes, changedArea) => {
    if (changedArea !== area) return;
    const change = changes[key];
    if (change) onChange(parse(change.newValue));
  });
}
