import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepNotaryLine, PROGRESS_IDLE_EVERY_MS, sanitizeFrame } from '@/infra/diag/record';
import type { ProofSnapshot } from '@/core/notary-snapshot';

type Record = typeof import('@/infra/diag/record');
type Store = typeof import('@/infra/diag/store');

/** A fresh service worker: the recorder, and the store it writes through, both from a clean module registry. */
async function spawn(): Promise<{ record: Record; store: Store }> {
  vi.resetModules();
  const record = await import('@/infra/diag/record');
  const store = await import('@/infra/diag/store');
  return { record, store };
}

const T0 = Date.UTC(2026, 9, 30, 12);

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

// The worker's own format: `ws#N PROGRESS <s> sent <total> (+<delta>) recv <total> (+<delta>) buffered <n> <url>`.
const tick = (ws: number, dSent: string, dRecv: string): string =>
  `proof abcd1234: ws#${ws} PROGRESS 5.0s sent 12.0MB (+${dSent}) recv 1.2MB (+${dRecv}) buffered 0 ` +
  `wss://notary.example/provenance/v1/ · MPC_SETUP for 5.0s`;

describe('keepNotaryLine', () => {
  it('keeps every line that is not a socket tick', () => {
    const last = new Map<string, number>();
    for (const line of ['proof abcd1234: stage MPC_SETUP 10%', 'proof abcd1234: ws#1 CLOSE wss://x code=1006', 'proof x: ws#1 ERROR']) {
      expect(keepNotaryLine(last, line, 'abcd1234', T0)).toBe(true);
      expect(keepNotaryLine(last, line, 'abcd1234', T0)).toBe(true);
    }
  });

  it('keeps every tick that moved bytes', () => {
    const last = new Map<string, number>();
    expect(keepNotaryLine(last, tick(1, '1.2MB', '0B'), 'p', T0)).toBe(true);
    expect(keepNotaryLine(last, tick(1, '0B', '14B'), 'p', T0 + 5_000)).toBe(true);
  });

  it('keeps a quiet tick only once per idle window', () => {
    const last = new Map<string, number>();
    expect(keepNotaryLine(last, tick(1, '0B', '0B'), 'p', T0)).toBe(true); // the first is the baseline
    expect(keepNotaryLine(last, tick(1, '0B', '0B'), 'p', T0 + 5_000)).toBe(false);
    expect(keepNotaryLine(last, tick(1, '0B', '0B'), 'p', T0 + PROGRESS_IDLE_EVERY_MS - 1)).toBe(false);
    expect(keepNotaryLine(last, tick(1, '0B', '0B'), 'p', T0 + PROGRESS_IDLE_EVERY_MS)).toBe(true);
  });

  it('throttles each socket of each proof on its own', () => {
    const last = new Map<string, number>();
    expect(keepNotaryLine(last, tick(1, '0B', '0B'), 'p', T0)).toBe(true);
    expect(keepNotaryLine(last, tick(2, '0B', '0B'), 'p', T0 + 1)).toBe(true);
    expect(keepNotaryLine(last, tick(1, '0B', '0B'), 'q', T0 + 2)).toBe(true);
    expect(keepNotaryLine(last, tick(1, '0B', '0B'), 'p', T0 + 3)).toBe(false);
  });

  it('keeps a tick whose deltas it cannot read', () => {
    const last = new Map<string, number>();
    keepNotaryLine(last, tick(1, '0B', '0B'), 'p', T0);
    expect(keepNotaryLine(last, 'proof p: ws#1 PROGRESS 5.0s something new', 'p', T0 + 1)).toBe(true);
  });
});

describe('sanitizeFrame', () => {
  it('keeps the tag and primitive fields, drops anything nested', () => {
    expect(sanitizeFrame({ event: 'CycleCompleted', watching: 2, ok: true, missing: null, nested: { a: 1 }, list: [1] })).toEqual({
      event: 'CycleCompleted',
      fields: { watching: 2, ok: true, missing: null },
    });
  });

  it('refuses a frame with no usable tag', () => {
    expect(sanitizeFrame({ dealId: 'x' })).toBeNull();
    expect(sanitizeFrame({ event: '' })).toBeNull();
    expect(sanitizeFrame('CycleStarted')).toBeNull();
  });
});

describe('the recorder', () => {
  it('writes PROGRESS lines only while bytes move, or once every 30 s; everything else always', async () => {
    const { record, store } = await spawn();
    const at = (s: number, line: string): void => {
      vi.setSystemTime(T0 + s * 1_000);
      record.recordNotary(line, 'info', 'abcd1234');
    };
    at(0, 'proof abcd1234: stage MPC_SETUP 10%');
    at(5, tick(1, '6.0MB', '1.0MB')); // moving → kept
    at(10, tick(1, '0B', '0B')); // quiet, 5 s after a kept line → dropped
    at(15, tick(1, '0B', '0B')); // dropped
    at(35, tick(1, '0B', '0B')); // quiet, 30 s after the last kept → kept
    at(40, tick(1, '0B', '0B')); // dropped
    at(41, 'proof abcd1234: stage SENDING_REQUEST 40%');
    at(42, 'proof abcd1234: ws#1 CLOSE wss://notary.example/provenance/v1/ code=1006 clean=false — sent 1B recv 1B');
    at(43, 'proof abcd1234: ws#1 ERROR wss://notary.example/provenance/v1/ — sent 1B recv 1B');
    at(44, 'proof summary — proofId=abcd1234 — timeout after 180000ms; stage SENDING_REQUEST 3.0s');

    const rows = await store.readDiagLog();
    expect(rows.map((r) => (r.ts - T0) / 1_000)).toEqual([0, 5, 35, 41, 42, 43, 44]);
    expect(rows.every((r) => r.section === 'notary' && r.event === 'NotaryProof')).toBe(true);
  });

  it('keeps a relayed snapshot as fields next to its line', async () => {
    const { record, store } = await spawn();
    const snapshot: ProofSnapshot = {
      stage: 'MPC_SETUP',
      stageSec: 4.2,
      elapsedMs: 5_000,
      notarySent: 12_582_912,
      notaryRecv: 1_048_576,
      notaryBuffered: 0,
      notaryIdleMs: 0,
      concurrent: 1,
      threadCount: 4,
      isolated: true,
      cores: 8,
      freshWorker: true,
    };
    record.recordNotary(tick(1, '6.0MB', '1.0MB'), 'info', 'abcd1234', snapshot);
    const [row] = await store.readDiagLog();
    expect(row?.fields).toEqual({ proofId: 'abcd1234', ...snapshot });
  });

  it('puts lifecycle frames and host state on the events section', async () => {
    const { record, store } = await spawn();
    record.recordLifecycle({ event: 'HeartbeatSent', ttlSeconds: 92 });
    record.recordState('BlockingReasonChanged', { reason: 'STEAM_SESSION_MISSING' });
    record.recordState('CoreBooted', { ext: '1.0.6', core: '1.1.1-beta', prover: 'f9cf7fa' });
    const rows = await store.readDiagLog();
    expect(rows.map((r) => [r.section, r.event])).toEqual([
      ['events', 'HeartbeatSent'],
      ['events', 'BlockingReasonChanged'],
      ['events', 'CoreBooted'],
    ]);
  });
});

describe('what never reaches the buffer', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3NjU2MTE5ODMzODc4MDMwMSJ9.c2lnbmF0dXJlLXZhbHVl';
  // The DMarket refresh token is opaque: no JWT shape, and short enough to slip under the long-run rule.
  const REFRESH = 'f3b1c2d4-9a8e-4b7c-8d6e-0a1b2c3d4e5f';
  const STEAM_LOGIN_SECURE = `76561198338780301%7C%7C${JWT}`;
  const SESSIONID = 'a1b2c3d4e5f6a7b8c9d0e1f2';
  const NONCE = 'n0nc3V4lu3XyQ';
  const AUTH = 'Au7hV4lu3Zq9';

  const STEAM_ID = '76561198338780301';
  const PARTNER_STEAM_ID = '76561198000000042';
  const DEAL_ID = 'Pq8xYk2LmN4vR7tW1zA5bC9dE3fG6hJ0kL2mN5pQ8rS4t:0577e9d2-5b1a-4c3e-9f7d-2a6b8c0e4d1f';
  const OFFER_ID = '9341708627';

  it('holds no credential in any shape, and keeps the ids support reads a deal from', async () => {
    expect(DEAL_ID.split(':')[0]).toHaveLength(45);
    const { record, store } = await spawn();

    record.recordLifecycle({
      event: 'ProofFailed',
      dealId: DEAL_ID,
      steamOfferId: OFFER_ID,
      tokenSteamId: STEAM_ID,
      partnerSteamId: PARTNER_STEAM_ID,
      reason: `GET https://api.steampowered.com/IEconService/GetTradeOffer/v1/?tradeofferid=${OFFER_ID}&access_token=${JWT} failed`,
      error: `Authorization: Bearer ${JWT}; Cookie: steamLoginSecure=${STEAM_LOGIN_SECURE}; sessionid=${SESSIONID}; nonce=${NONCE}&auth=${AUTH}`,
      accessToken: JWT,
      refreshToken: REFRESH,
      steamLoginSecure: STEAM_LOGIN_SECURE,
      sessionid: SESSIONID,
      nonce: NONCE,
      auth: AUTH,
      nested: { token: JWT },
    });
    record.recordNotary(`proof abcd1234: notary handshake failed — subprotocol bearer.${JWT} rejected`, 'error', 'abcd1234');
    record.recordNotary(
      `proof abcd1234: read GET /IEconService/GetTradeOffer/v1/?tradeofferid=${OFFER_ID}&access_token=${JWT} failed`,
      'error',
      'abcd1234',
    );
    record.recordNotary(`proof FAILED — dealId=${DEAL_ID}, axis=offer, offerId=${OFFER_ID} — {"RefreshToken":"${REFRESH}","nonce":"${NONCE}"}`, 'error');

    const dump = JSON.stringify(await store.readDiagLog());
    for (const secret of [JWT, REFRESH, SESSIONID, NONCE, AUTH, STEAM_LOGIN_SECURE, 'bearer.eyJ', 'access_token=eyJ']) {
      expect(dump).not.toContain(secret);
    }
    for (const id of [STEAM_ID, DEAL_ID, OFFER_ID]) expect(dump).toContain(id);
    expect(dump).not.toContain(PARTNER_STEAM_ID);
  });
});
