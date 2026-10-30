import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAG_DB, MAX_AGE_MS, planTrim, QUOTA, type DiagEntry, type DiagSection } from '@/infra/diag/store';

type Store = typeof import('@/infra/diag/store');

/** A fresh module instance is a respawned service worker: nothing in memory survives, only the database. */
async function spawn(): Promise<Store> {
  vi.resetModules();
  return import('@/infra/diag/store');
}

const T0 = Date.UTC(2026, 9, 30, 12);
const entry = (section: DiagSection, ts: number, event = 'E'): DiagEntry => ({ ts, section, event });

/** Bulk-write rows straight into the database, in one transaction — the quotas are too big to reach one append at a time. */
async function seed(rows: DiagEntry[]): Promise<void> {
  await (await spawn()).readDiagLog(); // creates the schema
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DIAG_DB);
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(new Error('open failed'));
  });
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction('entries', 'readwrite');
    for (const row of rows) t.objectStore('entries').add(row);
    t.oncomplete = (): void => resolve();
    t.onerror = (): void => reject(new Error('seed failed'));
  });
  db.close();
}

const count = (rows: DiagEntry[], section: DiagSection): number => rows.filter((r) => r.section === section).length;

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

describe('planTrim', () => {
  it('deletes nothing under the quota with nothing stale', () => {
    expect(planTrim([1, 2, 3], [], 3)).toEqual([]);
  });

  it('deletes the oldest of the section beyond its quota', () => {
    expect(planTrim([1, 2, 3, 4, 5], [], 3)).toEqual([1, 2]);
  });

  it('deletes every stale entry, whichever section it is in', () => {
    expect(planTrim([7, 8], [1, 2], 5)).toEqual([1, 2]);
  });

  it('takes stale entries out of the count before applying the quota', () => {
    // Four in the section, one stale: three remain, which is the quota, so nothing fresh goes.
    expect(planTrim([1, 2, 3, 4], [1], 3)).toEqual([1]);
  });
});

describe('the activity log database', () => {
  it('survives a service-worker respawn, and keeps numbering where it left off', async () => {
    const first = await spawn();
    await first.appendDiag(entry('events', T0, 'A'), T0);
    await first.appendDiag(entry('notary', T0 + 1, 'B'), T0 + 1);

    const second = await spawn();
    await second.appendDiag(entry('events', T0 + 2, 'C'), T0 + 2);
    const rows = await second.readDiagLog();

    expect(rows.map((r) => r.event)).toEqual(['A', 'B', 'C']);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('caps the events section at its quota and leaves the notary section alone', async () => {
    await seed([
      ...Array.from({ length: QUOTA.events }, (_, i) => entry('events', T0 + i, `ev${i}`)),
      ...Array.from({ length: 10 }, (_, i) => entry('notary', T0 + i, 'nt')),
    ]);
    const store = await spawn();
    await store.appendDiag(entry('events', T0 + 5_000, 'newest'), T0 + 5_000);
    const rows = await store.readDiagLog();

    expect(count(rows, 'events')).toBe(QUOTA.events);
    expect(count(rows, 'notary')).toBe(10);
    expect(rows.some((r) => r.event === 'ev0')).toBe(false);
    expect(rows.at(-1)?.event).toBe('newest');
  });

  it('caps the notary section at its quota, so a long proof cannot evict the timeline', async () => {
    await seed([
      ...Array.from({ length: 10 }, (_, i) => entry('events', T0 + i, 'ev')),
      ...Array.from({ length: QUOTA.notary + 50 }, (_, i) => entry('notary', T0 + i, `nt${i}`)),
    ]);
    const store = await spawn();
    await store.appendDiag(entry('notary', T0 + 5_000, 'newest'), T0 + 5_000);
    const rows = await store.readDiagLog();

    expect(count(rows, 'notary')).toBe(QUOTA.notary);
    expect(count(rows, 'events')).toBe(10);
    expect(rows.find((r) => r.section === 'notary')?.event).toBe('nt51');
  });

  it('drops entries older than 24 h from both sections on the next write', async () => {
    await seed([
      entry('events', T0 - MAX_AGE_MS - 1, 'old-event'),
      entry('notary', T0 - MAX_AGE_MS - 1, 'old-notary'),
      entry('events', T0 - MAX_AGE_MS, 'exactly-24h'),
      entry('notary', T0 - 1_000, 'fresh-notary'),
    ]);
    const store = await spawn();
    await store.appendDiag(entry('events', T0, 'now'), T0);

    expect((await store.readDiagLog()).map((r) => r.event)).toEqual(['exactly-24h', 'fresh-notary', 'now']);
  });

  it('clears both sections', async () => {
    const store = await spawn();
    await store.appendDiag(entry('events', T0), T0);
    await store.appendDiag(entry('notary', T0), T0);
    await store.clearDiagLog();
    expect(await store.readDiagLog()).toEqual([]);
  });

  it('is cleared when the user turns error reporting off', async () => {
    const store = await spawn();
    const { setReportingEnabledByUser } = await import('@/infra/report/consent');
    await store.appendDiag(entry('events', T0), T0);

    await setReportingEnabledByUser(true);
    expect(await store.readDiagLog()).toHaveLength(1);

    await setReportingEnabledByUser(false);
    expect(await store.readDiagLog()).toEqual([]);
  });
});
