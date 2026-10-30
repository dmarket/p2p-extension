import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  accountIdFromAccessToken,
  exportFileName,
  serializeDiagExport,
  steamIdFromCredential,
  type DiagExport,
} from '@/infra/diag/export';
import { DIAG_DB, type DiagEntry } from '@/infra/diag/store';
import { INSTALL_ID_KEY } from '@/infra/report/keys';
import { buildPayload } from '@/infra/report/payload';
import { setActivated } from '@/state/activation';
import { setActiveTrackingCount } from '@/state/activeCount';
import { setBlockingReason, setLinkedSteamId } from '@/state/blocking';
import { redactText } from '@/util/redact';

const b64url = (obj: object): string => btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (payload: object): string => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;

const STEAM_ID = '76561198000000001';
const PARTNER_STEAM_ID = '76561198999999999';
const ACCOUNT_ID = '4e2c1a9b-7d3f-4c8e-9a51-0b6d2f7e8c13';
const DEAL_ID = 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7cDe0fGh3iJ:0577e9d2-1c4b-4f5a-8e6d-2b9c7a1f3e40';
const OFFER_ID = '9313246543';
const INSTALL_ID = 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e';

// Every credential shape the extension handles. None of these may reach the file.
const ACCESS_TOKEN = jwt({ exp: 1_900_000_000, attributes: { account_id: ACCOUNT_ID } });
const NOTARY_TOKEN = jwt({ exp: 1_900_000_000, sub: 'notary' });
const SECRETS = {
  accessToken: ACCESS_TOKEN,
  refreshToken: 'opaque-refresh-7f3a9c1e2b4d',
  steamLoginSecure: `${STEAM_ID}%7C%7C${jwt({ sub: STEAM_ID })}`,
  sessionid: 'a1b2c3d4e5f60718293a4b5c',
  nonce: 'n0nce-9f8e7d6c5b4a',
  auth: 'auth-3c2b1a0f9e8d',
  notary: NOTARY_TOKEN,
  steamApiToken: 'steamapi-0123456789abcdef',
  credentialToken: 'live-credential-token-5e4d3c2b1a',
};

/** Raw rows, written straight to the database: proves the export's own pass, not just the recorder's. */
const RAW_ENTRIES: DiagEntry[] = [
  {
    ts: 1,
    section: 'events',
    event: 'TradeStatusReported',
    fields: {
      dealId: DEAL_ID,
      steamOfferId: OFFER_ID,
      partnerSteamId: PARTNER_STEAM_ID,
      accountid_other: '1039734271',
      accessToken: SECRETS.accessToken,
      refreshToken: SECRETS.refreshToken,
      steamLoginSecure: SECRETS.steamLoginSecure,
    },
  },
  {
    ts: 2,
    section: 'notary',
    event: 'NotaryProof',
    level: 'warn',
    note: `ws#1 CONNECTING wss://api.dmarket.com/provenance/v1/ protocols=tlsn.notary.v2,bearer.${SECRETS.notary} dealId=${DEAL_ID}, offerId=${OFFER_ID}`,
  },
  {
    ts: 3,
    section: 'notary',
    event: 'NotaryProof',
    note: `GET /IEconService/GetTradeOffer/v1/?tradeofferid=${OFFER_ID}&access_token=${SECRETS.steamApiToken} then sessionid=${SECRETS.sessionid}&nonce=${SECRETS.nonce}&auth=${SECRETS.auth}`,
  },
];

async function seed(rows: DiagEntry[]): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DIAG_DB, 1);
    req.onupgradeneeded = (): void => {
      const store = req.result.createObjectStore('entries', { keyPath: 'seq', autoIncrement: true });
      store.createIndex('section', 'section');
      store.createIndex('ts', 'ts');
    };
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

beforeEach(async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.resetModules(); // the store memoises its connection; a new IDBFactory needs a new module
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'test',
    version: '1.0.6',
    version_name: '1.0.6-beta',
  });
  vi.spyOn(fakeBrowser.cookies, 'get').mockResolvedValue({ value: SECRETS.accessToken } as never);
  await browser.storage.local.set({
    steam_credential: JSON.stringify({ token: SECRETS.credentialToken, steam_id: STEAM_ID, expires_at_ms: 1_900_000_000_000 }),
    [INSTALL_ID_KEY]: INSTALL_ID,
  });
  await setActivated(true);
  await setBlockingReason('STEAM_ACCOUNT_MISMATCH');
  await setActiveTrackingCount(2);
  await seed(RAW_ENTRIES);
});

/** The module under test, re-imported so it opens the database behind this test's IDBFactory. */
const build = async (): Promise<DiagExport> => (await import('@/infra/diag/export')).buildDiagExport(new Date('2026-10-30T12:34:56.789Z'));

describe('buildDiagExport', () => {
  it('carries no credential, no counterparty and keeps the ids support reads', async () => {
    const text = serializeDiagExport(await build());
    for (const [name, secret] of Object.entries(SECRETS)) expect(text, name).not.toContain(secret);
    expect(text).not.toContain(PARTNER_STEAM_ID);
    expect(text).not.toContain('1039734271');
    expect(text).toContain(DEAL_ID);
    expect(text).toContain(OFFER_ID);
    expect(text).toContain(STEAM_ID);
    expect(JSON.parse(text)).toEqual(expect.objectContaining({ entries: expect.any(Array) as unknown }));
  });

  it('fills every header field', async () => {
    const { header, entries } = await build();
    expect(header).toEqual({
      version: '1.0.6',
      versionName: '1.0.6-beta',
      buildId: 'test',
      proverBuild: 'test-prover',
      userAgent: navigator.userAgent,
      exportedAt: '2026-10-30T12:34:56.789Z',
      blockingReason: 'STEAM_ACCOUNT_MISMATCH',
      activated: true,
      activeDeals: 2,
      installId: INSTALL_ID,
      steamId64: STEAM_ID,
      dmarketUserId: ACCOUNT_ID,
    });
    expect(entries).toHaveLength(RAW_ENTRIES.length);
  });

  it('never mints an install id', async () => {
    await browser.storage.local.remove(INSTALL_ID_KEY);
    expect((await build()).header.installId).toBeUndefined();
    expect((await browser.storage.local.get(INSTALL_ID_KEY))[INSTALL_ID_KEY]).toBeUndefined();
  });

  it('falls back to the linked Steam id without a stored credential, and omits it with neither', async () => {
    await browser.storage.local.remove('steam_credential');
    await setLinkedSteamId('76561198000000002');
    expect((await build()).header.steamId64).toBe('76561198000000002');
    await setLinkedSteamId(undefined);
    expect((await build()).header.steamId64).toBeUndefined();
  });

  it('omits the DMarket account id when signed out or the cookie cannot be read', async () => {
    vi.spyOn(fakeBrowser.cookies, 'get').mockResolvedValue(null as never);
    expect((await build()).header.dmarketUserId).toBeUndefined();
    vi.spyOn(fakeBrowser.cookies, 'get').mockRejectedValue(new Error('no host permission'));
    expect((await build()).header.dmarketUserId).toBeUndefined();
  });
});

describe('steamIdFromCredential', () => {
  it('reads only steam_id, from the JSON string or an object', () => {
    const raw = JSON.stringify({ token: SECRETS.credentialToken, steam_id: STEAM_ID });
    expect(steamIdFromCredential(raw)).toBe(STEAM_ID);
    expect(steamIdFromCredential({ steam_id: STEAM_ID })).toBe(STEAM_ID);
    expect(steamIdFromCredential('{not json')).toBeUndefined();
    expect(steamIdFromCredential(JSON.stringify({ steam_id: SECRETS.credentialToken }))).toBeUndefined();
    expect(steamIdFromCredential(undefined)).toBeUndefined();
  });
});

describe('accountIdFromAccessToken', () => {
  it('reads attributes.account_id and nothing else', () => {
    expect(accountIdFromAccessToken(ACCESS_TOKEN)).toBe(ACCOUNT_ID);
    expect(accountIdFromAccessToken(jwt({ sub: ACCOUNT_ID }))).toBeUndefined();
    expect(accountIdFromAccessToken(jwt({ attributes: { account_id: 'a b"c' } }))).toBeUndefined();
    expect(accountIdFromAccessToken('not-a-jwt')).toBeUndefined();
  });

  it('is cut from automatic reports', async () => {
    expect(redactText(`deal failed for ${ACCOUNT_ID}`)).not.toContain(ACCOUNT_ID);
    const payload = await buildPayload({ context: 'background', message: 'boom', stack: null, timestamp: 'x' });
    expect(JSON.stringify(payload)).not.toContain(ACCOUNT_ID);
  });
});

describe('serializeDiagExport', () => {
  it('round-trips, with one entry per line', () => {
    const doc: DiagExport = { header: { exportedAt: 'x' } as DiagExport['header'], entries: RAW_ENTRIES };
    const text = serializeDiagExport(doc);
    expect(JSON.parse(text)).toEqual(doc);
    expect(text.split('\n').filter((line) => line.startsWith('    {"'))).toHaveLength(RAW_ENTRIES.length);
    expect(JSON.parse(serializeDiagExport({ ...doc, entries: [] }))).toEqual({ ...doc, entries: [] });
  });
});

describe('exportFileName', () => {
  it('has no colons', () => {
    expect(exportFileName('2026-10-30T12:34:56.789Z')).toBe('dmarket-trade-tracker-log-2026-10-30T12-34-56.789Z.json');
  });
});
