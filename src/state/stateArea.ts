// Which storage area a context reads the background's state mirrors from.
//
// On Chrome the service worker closes `storage.local` to content scripts (the core keeps a live Steam token
// there) and copies the few keys they need into `storage.session` (src/background/stateMirror.ts). Firefox has
// no `setAccessLevel` and never exposes `storage.session` to content scripts, so there they keep reading
// `storage.local`. Extension pages and the service worker always read `storage.local`, the source of truth.

const inContentScript = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);

export const STATE_AREA: 'local' | 'session' = inContentScript && !import.meta.env.FIREFOX ? 'session' : 'local';

/** Lazy: an orphaned content script has no `browser.storage`, and the caller's read then rejects. */
export const stateStorage = (): Browser.storage.StorageArea => browser.storage[STATE_AREA];
