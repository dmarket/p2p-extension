// IndexedDB-backed session log: a persistent ring buffer that survives MV3 service-worker teardown
// (in-memory state does not). Each entry is stamped with a monotonic `seq` and `ts`. Only the service
// worker writes; the debug page reads via the `debug:get-log` message. Ported from the tracker-core
// debug extension (tools/debug-extension/sessionLog.js), typed and trimmed to this extension's needs.
//
// DEV-ONLY: reachable only through the dev-gated dynamic import in src/entrypoints/background.ts.

import type { LogEntry } from '@/debug/protocol';

const DB_NAME = 'p2p-debug-log';
const STORE = 'entries';
const META = 'meta';

/** A stored entry always has seq + ts assigned. */
type StoredEntry = LogEntry & { seq: number; ts: number };

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * The reason to reject with, for an IndexedDB failure that may not name one.
 *
 * `IDBRequest.error` and `IDBTransaction.error` are both nullable, and an ABORTED transaction routinely
 * carries no error at all (an explicit `abort()`, or the store being deleted under us). Rejecting with
 * that raw value hands `catch (e)` a `null`, so the caller's own `e instanceof Error` / `e.message`
 * reads either lie or throw — inside a logger, whose whole job is to still say something useful when
 * things are going wrong. `DOMException` already extends `Error`, so the real one is passed through
 * untouched and only the absent case is synthesised.
 */
const idbFailure = (error: DOMException | null, what: string): Error =>
  error ?? new Error(`IndexedDB ${what} failed without an error (${DB_NAME})`);

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'seq' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(idbFailure(req.error, 'open'));
  });
  return dbPromise;
}

function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(t);
    t.oncomplete = (): void => resolve(result);
    t.onerror = (): void => reject(idbFailure(t.error, `${mode} transaction`));
    // Named separately from onerror: an abort with no error is the common case here, and knowing which
    // of the two fired is most of the diagnosis.
    t.onabort = (): void => reject(idbFailure(t.error, `${mode} transaction (aborted)`));
  });
}

let seqCounter: number | null = null;

/**
 * Lazy init, but init at most ONCE across concurrent callers.
 *
 * Every writer here is fire-and-forget (`void record(...)`, `void logLifecycle(...)`), so two appends
 * routinely overlap — and a plain `if (seqCounter === null) seqCounter = await …` lets both see `null`, both
 * await the read, and the second assignment clobber the first's increment. Both entries then get the same
 * `seq`, and since that is the store's keyPath the second `put` overwrites the first: an entry silently
 * missing from the persisted log while the live broadcast showed both. The core emits several events
 * back-to-back per cycle, so this hit the very cycle being diagnosed.
 */
let seqInit: Promise<number> | null = null;

async function nextSeq(db: IDBDatabase): Promise<number> {
  if (seqCounter === null) {
    seqInit ??= new Promise<number>((resolve) => {
      const t = db.transaction(META, 'readonly');
      const r = t.objectStore(META).get('seq');
      r.onsuccess = (): void => resolve((r.result as number) || 0);
      r.onerror = (): void => resolve(0);
    });
    const stored = await seqInit;
    // Whoever resumes first wins; a later resumption must not walk the counter back.
    seqCounter = Math.max(seqCounter ?? 0, stored);
  }
  seqCounter += 1;
  return seqCounter;
}

/**
 * Append an entry, stamping `seq` + `ts`, and trim the store to `maxEntries`. Returns the stored entry
 * (for live broadcast). `nowMs` is supplied by the caller since the service worker owns wall-clock time.
 */
export async function appendLog(entry: LogEntry, maxEntries: number, nowMs: number): Promise<StoredEntry> {
  const db = await openDb();
  const seq = await nextSeq(db);
  const stored: StoredEntry = { ...entry, seq, ts: nowMs };
  await tx(db, [STORE, META], 'readwrite', (t) => {
    t.objectStore(STORE).put(stored);
    t.objectStore(META).put(seq, 'seq');
  });
  await trim(db, maxEntries);
  return stored;
}

async function trim(db: IDBDatabase, maxEntries: number): Promise<void> {
  const count = await new Promise<number>((resolve) => {
    const t = db.transaction(STORE, 'readonly');
    const r = t.objectStore(STORE).count();
    r.onsuccess = (): void => resolve(r.result);
    r.onerror = (): void => resolve(0);
  });
  const excess = count - maxEntries;
  if (excess <= 0) return;
  await tx(db, [STORE], 'readwrite', (t) => {
    const store = t.objectStore(STORE);
    const cursorReq = store.openCursor(); // keyPath=seq, ascending → oldest first
    let removed = 0;
    cursorReq.onsuccess = (): void => {
      const cursor = cursorReq.result;
      if (cursor && removed < excess) {
        cursor.delete();
        removed += 1;
        cursor.continue();
      }
    };
  });
}

/** Return all entries, oldest first. */
export async function readAllLogs(): Promise<StoredEntry[]> {
  const db = await openDb();
  return new Promise((resolve) => {
    const t = db.transaction(STORE, 'readonly');
    const r = t.objectStore(STORE).getAll();
    r.onsuccess = (): void => resolve((r.result as StoredEntry[]) || []);
    r.onerror = (): void => resolve([]);
  });
}

/** Clear all entries and reset the sequence counter. */
export async function clearLogs(): Promise<void> {
  const db = await openDb();
  seqCounter = 0;
  // Drop the memoised read too, or a pending init could restore the pre-clear high-water mark.
  seqInit = null;
  await tx(db, [STORE, META], 'readwrite', (t) => {
    t.objectStore(STORE).clear();
    t.objectStore(META).put(0, 'seq');
  });
}
