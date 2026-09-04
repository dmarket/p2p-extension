import { describe, expect, it } from 'vitest';
import { TrackerConfig } from '@dmarket/p2p-tracker-core-domain';
import { buildTrackerConfig } from '@/core/config';
import type { TrackerOverrides } from '@/config/settings';

// Positional-semantics tests against the REAL installed core (the vitest alias resolves
// `@dmarket/p2p-tracker-core-domain` to the same compiled .mjs the build uses, so class identity and
// the positional `copy()` contract are exactly what ships).
//
// Complementary to scripts/check-core-params.mjs, which proves the *_ORDER arrays match the core's
// constructor NAMES and ARITY. What it cannot prove is that a given override object actually lands on
// the intended field — the gap a silently-inert override lives in (the simulator once looked healthy
// while a one-slot shift would have written a cookie name into a REGEX field). So the shape here is:
// pass a sentinel for ONE field per group, then assert the field of that declared name received it AND
// its slot neighbours kept their defaults.
//
// Two constraints on how that is asserted, both learned the hard way:
//  - sentinels must satisfy the core's constructor `require`s (batchSize stays 1..100, the credentials
//    gate headroom stays above the skew);
//  - never assert `copy` arity: Kotlin/JS data-class copy() carries trailing default-mask params, so
//    `fn.length` is inflated and meaningless.

// The ambient types (src/core/core-domain.d.ts) deliberately declare only `copy()` on each group — the
// data fields are real @JsExport value properties at runtime but are not part of the typed surface. This
// view declares exactly the fields these tests read, one cast in one place; a field named wrongly here
// fails its assertion against the real object, so the cast cannot hide a typo.
interface ConfigView {
  cadence: { webPollFloorMs: number; maxActionDelayMs: number; iosForegroundPollFloorMs: number };
  credentials: {
    marketplaceSessionGateHeadroomMs: number;
    sessionGateHeadroomMs: number;
    marketplaceRefreshMinLifeMs: number;
  };
  http: { requestTimeoutMs: number };
  marketplaceRetry: { maxRetries: number; retryBaseDelayMs: number; retryMaxDelayMs: number };
  marketplaceScrape: {
    cookieName: string;
    refreshUrl: string;
    refreshCookieName: string;
    tokenRefreshPath: string;
  };
  notary: {
    notaryUrl: string;
    proxyBaseUrl: string;
    maxSentData: number;
    maxRecvData: number;
    threadCount: number;
    acceptedProofTtlMs: number;
    maxRecvDataOnline: number;
    onlineBudgetMarginPercent: number;
    maxRecvRecordsOnline: number | null;
  };
  steamEndpoints: {
    historyMaxTrades: number;
    bulkOfferThreshold: number;
    paramAccessToken: string;
    getTradeHistoryPath: string;
  };
  steamProfile: { maxConcurrency: number; batchSize: number; requestTimeoutMs: number };
  steamScrape: {
    tokenRegex: unknown;
    steamIdRegex: unknown;
    steamSessionCookieName: string;
    steamSessionIdCookieName: string;
  };
  game: { cs2InventoryContextId: number };
}

const view = (cfg: unknown): ConfigView => cfg as ConfigView;

/** Fresh defaults to compare neighbours against. A new instance per call — configs are immutable, but
 *  reading from the same object a test mutated-by-copy would hide nothing. */
const defaults = () => view(new TrackerConfig());

const build = (o: TrackerOverrides, feUrl?: string): ConfigView => {
  const cfg = buildTrackerConfig(feUrl, o);
  expect(cfg).toBeDefined();
  return view(cfg);
};

describe('buildTrackerConfig — nothing to apply', () => {
  it('returns undefined for empty overrides and no feUrl (core runs on its own defaults)', () => {
    expect(buildTrackerConfig(undefined, {})).toBeUndefined();
    expect(buildTrackerConfig()).toBeUndefined();
  });

  it('a group absent from the overrides keeps every default in the built config', () => {
    const cfg = build({ http: { requestTimeoutMs: 45_000 } });
    const d = defaults();
    expect(cfg.http.requestTimeoutMs).toBe(45_000);
    // Untouched groups: spot-check one field per neighbouring group.
    expect(cfg.cadence.webPollFloorMs).toBe(d.cadence.webPollFloorMs);
    expect(cfg.marketplaceRetry.maxRetries).toBe(d.marketplaceRetry.maxRetries);
    expect(cfg.notary.maxRecvData).toBe(d.notary.maxRecvData);
  });
});

describe('buildTrackerConfig — one sentinel per group lands on its declared field, neighbours untouched', () => {
  it('cadence.webPollFloorMs (slot 3)', () => {
    const cfg = build({ cadence: { webPollFloorMs: 123_456 } });
    const d = defaults();
    expect(cfg.cadence.webPollFloorMs).toBe(123_456);
    expect(cfg.cadence.maxActionDelayMs).toBe(d.cadence.maxActionDelayMs); // slot 2
    expect(cfg.cadence.iosForegroundPollFloorMs).toBe(d.cadence.iosForegroundPollFloorMs); // slot 4
  });

  it('credentials.marketplaceSessionGateHeadroomMs (slot 3; must stay above the default skew)', () => {
    const cfg = build({ credentials: { marketplaceSessionGateHeadroomMs: 120_000 } });
    const d = defaults();
    expect(cfg.credentials.marketplaceSessionGateHeadroomMs).toBe(120_000);
    expect(cfg.credentials.sessionGateHeadroomMs).toBe(d.credentials.sessionGateHeadroomMs); // slot 2
    expect(cfg.credentials.marketplaceRefreshMinLifeMs).toBe(d.credentials.marketplaceRefreshMinLifeMs); // slot 4
  });

  it('marketplaceRetry.retryBaseDelayMs (slot 1)', () => {
    const cfg = build({ marketplaceRetry: { retryBaseDelayMs: 777 } });
    const d = defaults();
    expect(cfg.marketplaceRetry.retryBaseDelayMs).toBe(777);
    expect(cfg.marketplaceRetry.maxRetries).toBe(d.marketplaceRetry.maxRetries); // slot 0
    expect(cfg.marketplaceRetry.retryMaxDelayMs).toBe(d.marketplaceRetry.retryMaxDelayMs); // slot 2
  });

  it('notary.notaryUrl (slot 1) and notary.maxRecvData (slot 5)', () => {
    const cfg = build({ notary: { notaryUrl: 'wss://notary.test/provenance/v1/', maxRecvData: 8192 } });
    const d = defaults();
    expect(cfg.notary.notaryUrl).toBe('wss://notary.test/provenance/v1/');
    expect(cfg.notary.proxyBaseUrl).toBe(d.notary.proxyBaseUrl); // slot 2 — NOT the URL above
    expect(cfg.notary.maxRecvData).toBe(8192);
    expect(cfg.notary.maxSentData).toBe(d.notary.maxSentData); // slot 4
    expect(cfg.notary.threadCount).toBe(d.notary.threadCount); // slot 6
  });

  it('notary.maxRecvDataOnline (slot 13) and notary.maxRecvRecordsOnline (slot 17), across six position-only slots', () => {
    // The longest reach in the whole seam, and the one with the most to go wrong: seven slots were appended to
    // NOTARY_ORDER to get here, six of which nothing may set. `withOverrides` fills those with `undefined`,
    // which the core's positional `copy()` reads as "keep the receiver's value" — so the assertion that
    // matters is not that the two land, it is that the six between them did NOT move.
    const cfg = build({ notary: { maxRecvDataOnline: 2048, maxRecvRecordsOnline: 7 } });
    const d = defaults();

    expect(cfg.notary.maxRecvDataOnline).toBe(2048);
    expect(cfg.notary.maxRecvRecordsOnline).toBe(7);
    // Slots 11 and 16 — the two skipped-over slots that have a readable getter (`breaker`, `reads` and
    // `acknowledgeCommunityResponseDisclosure` are `@JsExport.Ignore`d in the core, so they keep their
    // constructor position but expose nothing to read back).
    expect(cfg.notary.acceptedProofTtlMs).toBe(d.notary.acceptedProofTtlMs); // slot 11
    expect(cfg.notary.onlineBudgetMarginPercent).toBe(d.notary.onlineBudgetMarginPercent); // slot 16
    // …and the group's earlier neighbours, since a mis-indexed tail would shift these too.
    expect(cfg.notary.maxRecvData).toBe(d.notary.maxRecvData); // slot 5
    expect(cfg.notary.threadCount).toBe(d.notary.threadCount); // slot 6
  });

  it('an unset notary.maxRecvRecordsOnline stays null — absent is not zero', () => {
    // The core sends no `maxRecvRecordsOnline` key to the prover while this is null, which keeps the artifact's
    // own contract default. A default of `0` here would instead publish a budget that cannot hold one record.
    expect(defaults().notary.maxRecvRecordsOnline).toBeNull();
    expect(build({ notary: { maxRecvDataOnline: 2048 } }).notary.maxRecvRecordsOnline).toBeNull();
  });

  it('steamEndpoints.bulkOfferThreshold (slot 10) and a path field', () => {
    const cfg = build({
      steamEndpoints: { bulkOfferThreshold: 3, getTradeHistoryPath: '/IEconService/GetTradeHistory/v2/' },
    });
    const d = defaults();
    expect(cfg.steamEndpoints.bulkOfferThreshold).toBe(3);
    expect(cfg.steamEndpoints.getTradeHistoryPath).toBe('/IEconService/GetTradeHistory/v2/');
    expect(cfg.steamEndpoints.historyMaxTrades).toBe(d.steamEndpoints.historyMaxTrades); // slot 9
    expect(cfg.steamEndpoints.paramAccessToken).toBe(d.steamEndpoints.paramAccessToken); // slot 11
  });

  it('steamProfile.batchSize (slot 2; core requires 1..100)', () => {
    const cfg = build({ steamProfile: { batchSize: 42 } });
    const d = defaults();
    expect(cfg.steamProfile.batchSize).toBe(42);
    expect(cfg.steamProfile.maxConcurrency).toBe(d.steamProfile.maxConcurrency); // slot 1
    expect(cfg.steamProfile.requestTimeoutMs).toBe(d.steamProfile.requestTimeoutMs); // slot 3
  });

  it('game.cs2InventoryContextId (slot 0)', () => {
    expect(build({ game: { cs2InventoryContextId: 9 } }).game.cs2InventoryContextId).toBe(9);
  });
});

describe('buildTrackerConfig — the marketplaceScrape group and the feUrl injection', () => {
  it('feUrl lands on refreshUrl even with no published scrape overrides', () => {
    const cfg = build({}, 'https://fe.test/');
    const d = defaults();
    expect(cfg.marketplaceScrape.refreshUrl).toBe('https://fe.test/');
    expect(cfg.marketplaceScrape.cookieName).toBe(d.marketplaceScrape.cookieName); // slot 0 — before it
    expect(cfg.marketplaceScrape.refreshCookieName).toBe(d.marketplaceScrape.refreshCookieName); // slot 2
  });

  it("the simulator's three cookie-name overrides land on their fields with the regex neighbours untouched", () => {
    // The case the cfg smoke existed for: a one-slot shift writes a cookie name into a REGEX field and
    // the simulation silently does nothing. check-core-params proves the ORDER matches the core's names;
    // this proves the VALUES route.
    const cfg = build(
      {
        marketplaceScrape: { cookieName: 'dmp-simulated-absent', refreshCookieName: 'dmp-simulated-absent' },
        steamScrape: { steamSessionCookieName: 'dmp-simulated-absent' },
      },
      'https://dmarket.com/',
    );
    const d = defaults();
    expect(cfg.marketplaceScrape.cookieName).toBe('dmp-simulated-absent');
    expect(cfg.marketplaceScrape.refreshCookieName).toBe('dmp-simulated-absent');
    expect(cfg.marketplaceScrape.tokenRefreshPath).toBe(d.marketplaceScrape.tokenRefreshPath);
    expect(cfg.steamScrape.steamSessionCookieName).toBe('dmp-simulated-absent');
    // Both regex slots and the sessionid cookie name kept their defaults.
    expect(String(cfg.steamScrape.tokenRegex)).toBe(String(d.steamScrape.tokenRegex));
    expect(String(cfg.steamScrape.steamIdRegex)).toBe(String(d.steamScrape.steamIdRegex));
    expect(cfg.steamScrape.steamSessionIdCookieName).toBe(d.steamScrape.steamSessionIdCookieName);
  });
});

describe('buildTrackerConfig — trailing-argument trimming', () => {
  it('a group holding nothing but undefined slots is trimmed away entirely, not copied', () => {
    // Every slot undefined ⇒ no arguments left ⇒ no copy() and no group, so an absent override stays
    // absent instead of becoming a copy that merely equals the default. With no feUrl either there is
    // nothing to build at all. The placeholder path a MIDDLE slot needs is the other half of the same
    // rule, and the slot-13/17 test above covers it across six position-only slots.
    expect(buildTrackerConfig(undefined, { notary: { notaryUrl: undefined } })).toBeUndefined();
    // …while one real value builds a real core class. The only instanceof check in the file: the seam
    // has to produce the core's own type, not a look-alike its positional copy() would still accept.
    expect(buildTrackerConfig(undefined, { notary: { notaryUrl: 'wss://notary.test/v1/' } })).toBeInstanceOf(
      TrackerConfig,
    );
  });
});
