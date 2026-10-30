// The local activity log: a ring buffer in IndexedDB that support asks the user to export by hand. It
// survives service-worker respawns and browser restarts, which is the point — the cycle a user complains about
// is never the one still in memory.
//
// Production code, unlike the dev console's session log (src/debug/sessionLog.ts), and deliberately its own
// database: a debug build runs both, and neither may trim or clear the other.
//
// Written by the service worker (src/infra/diag/record.ts decides what goes in), read by an extension page for
// the export, cleared from the popup when the user turns error reporting off. Free of runtime imports so that
// the popup can clear it without pulling the recorder and the redaction rules into its bundle.

export const DIAG_DB = 'p2p-diag-log';
const STORE = 'entries';

/**
 * Two sections with separate quotas, so one long proof cannot evict the rest: a proof that hangs to its 180 s
 * deadline narrates every 5 s on two sockets, and in a single quota it would push out the hours of lifecycle
 * events that say what the tracker was doing around it.
 */
export type DiagSection = 'events' | 'notary';

export type DiagValue = string | number | boolean | null;

export interface DiagEntry {
  /** Assigned by IndexedDB on write. Its key generator is persisted, so the order holds across respawns. */
  seq?: number;
  /** Epoch ms. */
  ts: number;
  section: DiagSection;
  /** A core lifecycle event name, `NotaryProof`, or one of the host's own (`CoreBooted`, …). */
  event: string;
  level?: 'info' | 'warn' | 'error';
  note?: string;
  fields?: Record<string, DiagValue>;
}

/** Retention: the last 24 h or {@link QUOTA} entries per section, whichever is smaller. */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 2000 entries in all. The timeline gets the larger share: it is what support reads first, and its busiest
 * observed hour (a deal retrying every tick) wrote ~600 events. A throttled proof writes ~30-60 lines, so the
 * notary share still holds the last 13-26 proofs.
 */
export const QUOTA: Readonly<Record<DiagSection, number>> = { events: 1200, notary: 800 };

/**
 * The keys to delete after a write: every entry past {@link MAX_AGE_MS} (any section), then the oldest of the
 * written section beyond its quota. Stale entries are taken out of the count first, so the age rule never makes
 * the count rule delete a fresh entry on top.
 *
 * @param sectionKeys the written section's keys, oldest first
 * @param staleKeys keys of entries older than the cutoff, from any section
 */
export function planTrim(sectionKeys: readonly number[], staleKeys: readonly number[], quota: number): number[] {
  const stale = new Set(staleKeys);
  const fresh = sectionKeys.filter((key) => !stale.has(key));
  return [...stale, ...fresh.slice(0, Math.max(0, fresh.length - quota))];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DIAG_DB, 1);
    req.onupgradeneeded = (): void => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
      store.createIndex('section', 'section');
      store.createIndex('ts', 'ts');
    };
    req.onsuccess = (): void => {
      // A connection the browser closes under us (storage pressure, a cleared profile) must not be reused.
      req.result.onclose = (): void => {
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = (): void => reject(req.error ?? new Error(`IndexedDB open failed (${DIAG_DB})`));
  }).catch((e: unknown) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

function run(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => void): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        fn(t.objectStore(STORE));
        const failed = (): void => reject(t.error ?? new Error(`IndexedDB ${mode} transaction aborted (${DIAG_DB})`));
        t.oncomplete = (): void => resolve();
        t.onerror = failed;
        t.onabort = failed;
      }),
  );
}

/** Append one entry and apply the retention, in one transaction. `now` is the clock the age cutoff is cut on. */
export function appendDiag(entry: DiagEntry, now: number): Promise<void> {
  return run('readwrite', (store) => {
    store.add(entry);
    const section = store.index('section').getAllKeys(IDBKeyRange.only(entry.section));
    const stale = store.index('ts').getAllKeys(IDBKeyRange.upperBound(now - MAX_AGE_MS, true));
    // Requests in one transaction complete in order, so `section` already has its result here.
    stale.onsuccess = (): void => {
      const doomed = planTrim(section.result as number[], stale.result as number[], QUOTA[entry.section]);
      for (const key of doomed) store.delete(key);
    };
  });
}

/** The whole buffer, both sections, oldest first — for the export. */
export async function readDiagLog(): Promise<DiagEntry[]> {
  let rows: DiagEntry[] = [];
  await run('readonly', (store) => {
    const req = store.getAll();
    req.onsuccess = (): void => {
      rows = req.result as DiagEntry[];
    };
  });
  return rows;
}

export const clearDiagLog = (): Promise<void> => run('readwrite', (store) => void store.clear());
