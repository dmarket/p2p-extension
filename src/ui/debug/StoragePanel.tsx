import { useEffect, useState } from 'preact/hooks';
import { ACTIVATION_KEY } from '@/state/activation';
import { DEMAND_KEY } from '@/debug/demandState';
import { BLOCKING_KEY } from '@/state/blocking';
import { KNOWN_KEYS } from '@/ui/debug/storageKeys';
import { BlockingStatePanel } from '@/ui/debug/BlockingStatePanel';
import { DemandPanel } from '@/ui/debug/DemandPanel';
import { highlight } from '@/ui/debug/format';
import { redactSecrets } from '@/util/redact';

type StoreMap = Record<string, unknown>;

/** A short type label for the badge. */
function typeLabel(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Parse a string that holds a JSON object/array; `undefined` when it isn't one. */
function parseJsonish(s: string): unknown {
  const t = s.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Replace JSON-in-string values with the parsed value, recursively. Most of the interesting data here is
 * stored as an escaped JSON *string*: `remoteconfig.cache` is an object whose `p2p_tracker_config` value
 * is the whole config document as one string, and every core-owned key is a JSON string too — so a plain
 * `JSON.stringify` renders them as a single unreadable `"{\"tracker\":{…}}"` line. Display-only: `edit`
 * still shows (and saves) the raw stored value. `hit` records whether anything was expanded.
 */
function expandJsonStrings(v: unknown, hit: { any: boolean }): unknown {
  if (typeof v === 'string') {
    const parsed = parseJsonish(v);
    if (parsed === undefined) return v;
    hit.any = true;
    return expandJsonStrings(parsed, hit);
  }
  if (Array.isArray(v)) return v.map((item) => expandJsonStrings(item, hit));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, expandJsonStrings(val, hit)]));
  }
  return v;
}

/**
 * Scrub every string inside a value, keeping its structure (an array of crash reports stays an array) so an
 * export is still readable. Each string is scrubbed under its own key, so an `…id` field keeps its id.
 */
function redactDeep(v: unknown, keyName?: string): unknown {
  if (typeof v === 'string') return redactSecrets(v, keyName);
  if (Array.isArray(v)) return v.map((item) => redactDeep(item));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, redactDeep(val, k)]));
  }
  return v;
}

/** Human-readable display of a value: pretty JSON with nested JSON strings expanded (see above). */
function displayValue(v: unknown): { text: string; expanded: boolean } {
  const hit = { any: false };
  const value = expandJsonStrings(v, hit);
  if (typeof value === 'string') return { text: value, expanded: false };
  try {
    return { text: JSON.stringify(value, null, 2), expanded: hit.any };
  } catch {
    return { text: String(value), expanded: hit.any };
  }
}

/** The editable text for a value: raw string for string values; JSON for everything else. */
function editText(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function StorageRow({ keyName, value }: { keyName: string; value: unknown }): preact.JSX.Element {
  const info = KNOWN_KEYS[keyName];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  const [note, setNote] = useState('');

  const isString = typeof value === 'string';
  const masked = info?.sensitive && !revealed;
  const shown = displayValue(value);
  // A `sensitive` key is scrubbed rather than blanked out: a full `••••` also hid the parts that are the
  // evidence — `steam_credential`'s `steam_id` and expiry are exactly what a wrong-account trace is read
  // from, and blanking them was the reason to click "reveal" (i.e. to expose the live token) every time.
  const text = masked ? redactSecrets(shown.text) : shown.text;

  const startEdit = (): void => {
    setDraft(editText(value));
    setNote('');
    setEditing(true);
  };

  const save = (): void => {
    // Preserve the value's JS type: string values are written verbatim (the core reads its keys only
    // when they are strings); non-string values round-trip through JSON so booleans/objects keep their
    // type (e.g. activation.enabled stays boolean, remoteconfig.cache stays an object).
    let toStore: unknown;
    if (isString) {
      toStore = draft;
    } else {
      try {
        toStore = JSON.parse(draft);
      } catch {
        toStore = draft;
        setNote('Not valid JSON — stored as a string.');
      }
    }
    void browser.storage.local.set({ [keyName]: toStore }).then(() => setEditing(false));
  };

  const remove = (): void => {
    void browser.storage.local.remove(keyName);
  };

  return (
    <details class="store-row">
      <summary>
        <span class="store-key">{keyName}</span>
        <span class={`store-type ${info ? '' : 'unknown'}`}>{typeLabel(value)}</span>
        {info?.sensitive && <span class="store-type" style="background:#e74c3c33">sensitive</span>}
        {!info && <span class="muted">(unlisted)</span>}
      </summary>
      {info && <div class="store-desc">{info.desc}</div>}
      <div class="store-body">
        {!editing ? (
          <>
            {/* Same escaped-HTML JSON highlighter the log viewer uses (MV3 CSP forbids a remote lib). */}
            <pre dangerouslySetInnerHTML={{ __html: highlight(text, 'json') }} />
            {masked && (
              <div class="parse-note">
                Credentials redacted, identifiers kept — the same line the session log draws. “reveal” shows the raw
                value.
              </div>
            )}
            {!masked && shown.expanded && (
              <div class="parse-note">JSON strings expanded for reading — “edit” shows the raw stored value.</div>
            )}
            <div class="store-actions">
              <button onClick={startEdit}>edit</button>
              <button onClick={() => void navigator.clipboard.writeText(text)} title="Copy the value as shown">
                copy
              </button>
              {info?.sensitive && (
                <button onClick={() => setRevealed((r) => !r)}>{revealed ? 'hide' : 'reveal'}</button>
              )}
              <span class="spacer" />
              <button class="danger" onClick={remove}>
                delete
              </button>
            </div>
          </>
        ) : (
          <>
            <textarea value={draft} onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)} />
            {note && <div class="parse-note">{note}</div>}
            <div class="store-actions">
              <button onClick={save}>save</button>
              <button onClick={() => setEditing(false)}>cancel</button>
              <span class="parse-note">{isString ? 'stored as string' : 'stored as JSON (type preserved)'}</span>
            </div>
          </>
        )}
      </div>
    </details>
  );
}

function AddForm(): preact.JSX.Element {
  const [key, setKey] = useState('');
  const [val, setVal] = useState('');
  const [asJson, setAsJson] = useState(false);
  const [err, setErr] = useState('');

  const add = (): void => {
    if (!key.trim()) {
      setErr('Key is required.');
      return;
    }
    let toStore: unknown = val;
    if (asJson) {
      try {
        toStore = JSON.parse(val);
      } catch {
        setErr('Value is not valid JSON.');
        return;
      }
    }
    void browser.storage.local.set({ [key.trim()]: toStore }).then(() => {
      setKey('');
      setVal('');
      setErr('');
    });
  };

  return (
    <div class="add-form">
      <strong>Add key</strong>
      <input type="text" placeholder="key" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
      <textarea placeholder="value" value={val} onInput={(e) => setVal((e.target as HTMLTextAreaElement).value)} />
      <div class="store-actions">
        <label class="muted">
          <input type="checkbox" checked={asJson} onChange={(e) => setAsJson((e.target as HTMLInputElement).checked)} />{' '}
          parse as JSON (for booleans/objects)
        </label>
        <span class="spacer" />
        <button onClick={add}>add</button>
      </div>
      {err && <div class="error-banner">{err}</div>}
    </div>
  );
}

export function StoragePanel(): preact.JSX.Element {
  const [store, setStore] = useState<StoreMap>({});

  const refresh = (): void => {
    void browser.storage.local.get(null).then((all) => setStore(all));
  };

  useEffect(() => {
    refresh();
    const listener = (_changes: unknown, area: Browser.storage.AreaName): void => {
      if (area === 'local') refresh();
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);

  const clearAll = (): void => {
    if (confirm('Clear ALL browser.storage.local for this extension? This resets activation, core loop state, and credentials.')) {
      void browser.storage.local.clear();
    }
  };

  const exportAll = (): void => {
    // Keys flagged `sensitive` in the catalog — the ones holding a live CREDENTIAL — are SCRUBBED on the way
    // out, not omitted. An export is a file that gets attached to issues and pasted into chats, which is
    // exactly how a durable Steam credential got out of this tool once before, so the token must not travel;
    // but blanking the whole value also threw away `steam_credential`'s `steam_id` and expiry, which are what
    // a session or wrong-account bug is read from. Same line as the session log: credentials go, identifiers
    // stay. Everything not flagged is exported as stored, and a raw value is still one "reveal" click away.
    const redacted = Object.fromEntries(
      Object.entries(store).map(([key, value]) =>
        KNOWN_KEYS[key]?.sensitive === true ? [key, redactDeep(value, key)] : [key, value],
      ),
    );
    const blob = new Blob([JSON.stringify(redacted, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `p2p-storage-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importAll = (): void => {
    const raw = prompt('Paste JSON to merge into browser.storage.local:');
    if (!raw) return;
    try {
      // `unknown`, not the `any` JSON.parse hands back: the shape check below is what earns the cast.
      const obj: unknown = JSON.parse(raw);
      if (obj && typeof obj === 'object') void browser.storage.local.set(obj);
      else alert('JSON must be an object of key/value pairs.');
    } catch {
      alert('Invalid JSON.');
    }
  };

  const keys = Object.keys(store).sort();

  return (
    <section class="panel">
      {/* The Activate / Deactivate / Reset-onboarding strip lived here. Removed: the activation flag now has
          exactly two controls, both in context — the "Not activated" chip in the tracker.blockingReason
          switcher, and the `activation.enabled` row's own edit/delete. */}
      <div class="toolbar">
        <strong>Storage</strong>
        <span class="pill">{keys.length}</span>
        <span class="spacer" style="flex:1" />
        <button onClick={refresh}>refresh</button>
        <button onClick={exportAll}>export</button>
        <button onClick={importAll}>import</button>
        <button class="danger" onClick={clearAll}>
          clear all
        </button>
      </div>
      <div class="scroll">
        <AddForm />
        {/* PINNED, and rendered even when the key is absent: the row list is derived from the store's own
            keys, so on a fresh install (no cycle has run yet) the state chain and the simulator — the thing
            a fresh install most wants — would not exist at all. It is also the one key with no `edit`, so it
            cannot go through StorageRow. */}
        <BlockingStatePanel value={store[BLOCKING_KEY]} activated={store[ACTIVATION_KEY]} />
        {/* Pinned for the same reason, and rendered beside the row that holds its ANSWER: `tracker_prove_after`
            is where the core records whether it satisfied the mark or is sitting on a backoff ladder, which is
            what "the mark was stamped and nothing happened" is diagnosed from. */}
        <DemandPanel value={store['tracker_prove_after']} />
        {keys.length === 0 && <div class="muted">browser.storage.local is empty.</div>}
        {keys
          .filter((k) => k !== BLOCKING_KEY && k !== DEMAND_KEY && k !== 'tracker_prove_after')
          .map((k) => (
            <StorageRow key={k} keyName={k} value={store[k]} />
          ))}
      </div>
    </section>
  );
}
