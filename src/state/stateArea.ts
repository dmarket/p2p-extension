// Where a context reads the few keys of the worker's state that content scripts need.
//
// On Chrome the service worker closes both `storage.local` and `storage.session` to content scripts
// (src/background/stateMirror.ts): the core keeps a live Steam web-API token in `storage.session` (older cores:
// `storage.local`), and a content script runs in the page's renderer process. So a content script asks the
// worker for those keys by message ({@link STATE_GET_KIND}) and hears about changes the same way
// ({@link STATE_CHANGED_KIND}); its area is called `'mirror'`. Firefox has no `setAccessLevel` and never exposes
// `storage.session` to content scripts, so there they keep reading `storage.local`. Extension pages and the
// service worker always read `storage.local`, the source of truth.

const inContentScript = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);

/** `'mirror'` is not a browser storage area: it is the worker answering by message. */
export type StateAreaName = 'local' | 'mirror';

export const STATE_AREA: StateAreaName = inContentScript && !import.meta.env.FIREFOX ? 'mirror' : 'local';

/** Content script -> worker: read these keys. The worker answers only the keys it mirrors. */
export const STATE_GET_KIND = 'state:get';

export interface StateGetMessage {
  kind: typeof STATE_GET_KIND;
  keys: string[];
}

/** Worker -> content scripts: these mirrored keys changed in `storage.local`. */
export const STATE_CHANGED_KIND = 'state:changed';

export interface StateChangedMessage {
  kind: typeof STATE_CHANGED_KIND;
  changes: Record<string, { newValue: unknown }>;
}

export function isStateGet(m: unknown): m is StateGetMessage {
  const r = m as Partial<StateGetMessage> | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    r.kind === STATE_GET_KIND &&
    Array.isArray(r.keys) &&
    r.keys.every((k) => typeof k === 'string')
  );
}

export function isStateChanged(m: unknown): m is StateChangedMessage {
  const r = m as Partial<StateChangedMessage> | null;
  return typeof r === 'object' && r !== null && r.kind === STATE_CHANGED_KIND && typeof r.changes === 'object' && r.changes !== null;
}

export interface StateReader {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
}

/** No reply (worker refused, orphaned context) reads as `{}`: every key absent. */
const mirror: StateReader = {
  async get(keys) {
    try {
      const reply = await browser.runtime.sendMessage<StateGetMessage, Record<string, unknown> | undefined>({
        kind: STATE_GET_KIND,
        keys: typeof keys === 'string' ? [keys] : keys,
      });
      return typeof reply === 'object' && reply !== null ? reply : {};
    } catch {
      return {};
    }
  },
};

/** Lazy: an orphaned content script has no `browser.storage`, and the caller's read then rejects. */
export const stateStorage = (): StateReader => (STATE_AREA === 'mirror' ? mirror : browser.storage.local);
