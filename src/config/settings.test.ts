import { describe, expect, it, vi } from 'vitest';
import {
  getMarketplaceCookieName,
  getSteamSessionCookieName,
  parseSettings,
  subscribeSettings,
  type TrackerOverrides,
} from '@/config/settings';
import { REMOTE_CONFIG_PARAM } from '@/infra/remoteConfig';
import { flushMacrotasks, publishRemoteConfig, stubManifest } from '@/testing/stubs';

// The Remote Config overlay: one JSON document, delivered to every client over an unauthenticated
// public REST call, merged over compiled defaults. The contract under test is asymmetric on purpose —
// a valid field applies, and EVERYTHING else (malformed, out-of-range, off-host, or a field that must
// never be remotely settable) silently keeps the default. This suite is the permanent home for that
// contract — including the regressions behind it: a stale published document, the proxy URL scheme, and
// the fields (read definitions, trust anchor) a publish must never be able to reach.

/** Wrap a config document the way the RC cache stores it: ONE param whose value is a JSON string. */
const entries = (doc: unknown) => ({ [REMOTE_CONFIG_PARAM]: JSON.stringify(doc) });

/** parseSettings for a document, as most tests need it. */
const parse = (doc: unknown) => parseSettings(entries(doc));

describe('parseSettings — document shape', () => {
  // GUARD AGAINST VACUOUS PASSES (the trap that once let a whole smoke pass while testing nothing):
  // groups live under `root.tracker` / `root.web`. A doc with `notary` at the ROOT produces the same
  // `undefined` group as a rejected one, so every "was dropped" assertion below is only meaningful
  // because this test pins that a correctly-placed value APPLIES.
  it('applies a correctly placed override (the positive control for every rejection test)', () => {
    const s = parse({
      tracker: { notary: { maxRecvData: 8192 }, cadence: { webPollFloorMs: 90_000 } },
      web: { refreshDebounceMs: 5000 },
    });
    expect(s.tracker.notary?.maxRecvData).toBe(8192);
    expect(s.tracker.cadence?.webPollFloorMs).toBe(90_000);
    expect(s.web.refreshDebounceMs).toBe(5000);
  });

  it('a group at the ROOT (not under tracker) is ignored', () => {
    expect(parse({ notary: { maxRecvData: 8192 } }).tracker.notary).toBeUndefined();
  });

  it('never throws and yields defaults for hostile documents', () => {
    const hostile: unknown[] = [
      'not json at all',
      '[1,2,3]',
      '42',
      'null',
      JSON.stringify({ tracker: [] }),
      JSON.stringify({ tracker: { notary: 'string' } }),
      JSON.stringify({ tracker: { cadence: { webPollFloorMs: 'NaN' } } }),
      JSON.stringify({ __proto__: { polluted: true }, constructor: { prototype: {} } }),
    ];
    for (const raw of hostile) {
      const s = parseSettings({ [REMOTE_CONFIG_PARAM]: raw as string });
      expect(s.tracker).toEqual({});
      expect(s.web.refreshDebounceMs).toBe(3000);
    }
    // And an absent / non-string param.
    expect(parseSettings({}).tracker).toEqual({});
    expect(parseSettings({ other_param: 'x' }).tracker).toEqual({});
  });

  it('a group with only invalid fields is omitted entirely, not present-but-empty', () => {
    const s = parse({ tracker: { cadence: { webPollFloorMs: -1, maxActionDelayMs: 'soon' } } });
    // `undefined`, so buildTrackerConfig's withOverrides sees an ABSENT group and the core keeps its
    // own defaults instead of receiving an equal-to-default copy.
    expect(s.tracker.cadence).toBeUndefined();
  });
});

// Two mechanisms, one outcome, and the difference is worth knowing when reading a failure here:
// `CoreOnlyNotaryParam` fields are off `NotaryOverrides` and so have no NOTARY_SCHEMA entry at all —
// `pickGroup` iterates the schema, so nothing looks at them — while `rootStorePem` keeps an entry with a
// `rejectAlways` validator, because the extension itself sets it from a dev-only build variable and only the
// remote channel may close. These tests assert the OUTCOME, which is identical, so they hold either way.
describe('the never-remotely-settable notary fields', () => {
  it('drops offerRead / historyRead / rootStorePem while a legitimate neighbour still applies', () => {
    const s = parse({
      tracker: {
        notary: {
          // The two read definitions decide WHICH Steam read a proof attests; the PEM is a trust anchor.
          offerRead: { serverName: 'evil.example', pathTemplate: '/x?t={token}' },
          historyRead: { serverName: 'evil.example', pathTemplate: '/y?t={token}' },
          rootStorePem: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
          maxRecvData: 8192,
        },
      },
    });
    const notary = s.tracker.notary as NonNullable<TrackerOverrides['notary']>;
    expect(notary.maxRecvData).toBe(8192); // the block itself was processed…
    expect('offerRead' in notary).toBe(false); // …and the anchors are gone, not undefined-but-present
    expect('historyRead' in notary).toBe(false);
    expect('rootStorePem' in notary).toBe(false);
  });

  it('drops the position-only slots that stand between rootStorePem and the budget knobs', () => {
    // These exist in NOTARY_ORDER solely so `maxRecvDataOnline` (13) and `maxRecvRecordsOnline` (17) can be
    // addressed by index. Publishing any of them must be a no-op: `acceptedProofTtlMs` could suppress a
    // re-proof indefinitely, `acknowledgeCommunityResponseDisclosure` would publish an unmeasured
    // `steamcommunity.com` header set, and `breaker` / `reads` are Kotlin objects a JSON document cannot
    // produce anyway. `onlineBudgetMarginPercent` is refused by choice, not by necessity — if that is ever
    // opened, this expectation is the one to move.
    const s = parse({
      tracker: {
        notary: {
          acceptedProofTtlMs: 86_400_000,
          breaker: { failureThreshold: 1 },
          reads: { enabled: ['CREATE_OFFER'] },
          acknowledgeCommunityResponseDisclosure: true,
          onlineBudgetMarginPercent: 400,
          maxRecvDataOnline: 2048,
        },
      },
    });
    const notary = s.tracker.notary as Record<string, unknown>;
    // The one legitimate key in the block survives, so this is a per-key refusal and not a rejected block.
    expect(Object.keys(notary)).toEqual(['maxRecvDataOnline']);
    expect(notary.maxRecvDataOnline).toBe(2048);
  });

  it('accepts the two online-decryption budgets and refuses a zero for either', () => {
    const ok = parse({ tracker: { notary: { maxRecvDataOnline: 4096, maxRecvRecordsOnline: 7 } } });
    expect(ok.tracker.notary?.maxRecvDataOnline).toBe(4096);
    expect(ok.tracker.notary?.maxRecvRecordsOnline).toBe(7);

    // `0` is not "turn the preprocessing off" — it is a budget that cannot hold a single record, which is the
    // deterministic `record layer error` reached from the other direction. Both floors are `int(1)`.
    const zero = parse({ tracker: { notary: { maxRecvDataOnline: 0, maxRecvRecordsOnline: 0 } } });
    expect(zero.tracker.notary).toBeUndefined();
  });

  it('sentBudgetMarginPercent: accepts 0 and the rollback value, refuses a negative', () => {
    // The send-budget margin (slot 18) is the rollback for `ProvenSentBudget`'s per-proof sizing, so the two
    // values that must survive validation are the extremes: `0` sizes to the measured requirement exactly, and
    // anything >= 43 pushes the computed budget past `maxSentData`, where it clamps back to today's flat
    // behaviour. `0` is the interesting one — `int(0)` returns it and `pickGroup` keeps it, where a truthiness
    // test would drop it and leave the compiled 15 in force while the document says otherwise.
    expect(parse({ tracker: { notary: { sentBudgetMarginPercent: 0 } } }).tracker.notary)
      .toEqual({ sentBudgetMarginPercent: 0 });
    expect(
      parse({ tracker: { notary: { sentBudgetMarginPercent: 100 } } }).tracker.notary
        ?.sentBudgetMarginPercent,
    ).toBe(100);

    // Negative is the one value the core rejects with a `require`, which throws inside `copy()` where
    // `buildTrackerConfig` has no guard — i.e. the tracker would not start. Refused here so the default holds.
    expect(parse({ tracker: { notary: { sentBudgetMarginPercent: -1 } } }).tracker.notary).toBeUndefined();
    expect(parse({ tracker: { notary: { sentBudgetMarginPercent: '15' } } }).tracker.notary).toBeUndefined();
  });

  it('the stale-RC incident document, verbatim as it was still published: nothing survives', () => {
    // The pre-retarget notary block that was still live when the reads moved to the Steam API — it pointed
    // every proof at the old community HTML page. Four of its five field names no longer exist in the schema,
    // which is what saved the retargeted reads; `proxyBaseUrl` was the one that stayed publishable, and this
    // is its value as actually read back from the published document on 2026-09-03: **the notary's own URL**,
    // i.e. the target dial aimed at a service that does not proxy TCP to Steam. It went unnoticed for two
    // weeks because the target socket is dialled lazily, after MPC pre-processing succeeds — and a notary
    // problem meant it never did. The whole group is refused now, so the group itself is undefined.
    const s = parse({
      tracker: {
        notary: {
          enabled: false,
          proxyBaseUrl: 'wss://api.dmarket.com/provenance/v1/',
          provenServerName: 'steamcommunity.com',
          offerReadPathTemplate: '/tradeoffer/{offerId}/',
          historyReadPathTemplate: '/profiles/{steamId}/tradehistory/',
        },
      },
    });
    expect(s.tracker.notary).toBeUndefined();
  });

  it('proxyBaseUrl is refused even when it names the correct proxy', () => {
    // Not "the bad value is rejected" — the FIELD is. A validator that only refused the wrong URL would have
    // to know which proxy is deployed, and that knowledge is exactly what ships with the code instead.
    expect(parse({ tracker: { notary: { proxyBaseUrl: 'wss://p2p-wss-proxy.dmarket.com' } } }).tracker.notary)
      .toBeUndefined();
  });
});

describe('URL validators', () => {
  it('wssUrl: rejects http:// (the scheme BE actually sent), accepts ws:// and wss://, rejects garbage', () => {
    // `notaryUrl` is the only field left on this validator — `proxyBaseUrl` used to be the subject here, and
    // is now refused outright. The http:// case is not hypothetical: BE asked for the proxy to be configured
    // as `http://p2p-wss-proxy.dmarket.com/`, which is not a WebSocket scheme.
    const notary = (v: unknown) => parse({ tracker: { notary: { notaryUrl: v } } }).tracker.notary?.notaryUrl;
    expect(notary('http://api.dmarket.com/provenance/v1/')).toBeUndefined();
    expect(notary('wss://api.dmarket.com/provenance/v1/')).toBe('wss://api.dmarket.com/provenance/v1/');
    expect(notary('ws://localhost:9090')).toBe('ws://localhost:9090');
    expect(notary('not a url')).toBeUndefined();
    expect(notary('')).toBeUndefined();
  });

  it('notaryUrl: a published null is dropped, not preserved as an explicit unset', () => {
    // It WAS preserved, back when a null notaryUrl selected the no-op prover. The core now defaults the
    // field to the production notary and gates the prover on the proof delegate instead, so a published
    // null has nothing left to say — and, forwarded, would put a null in a non-null Kotlin parameter.
    // Dropping it leaves the group empty, hence undefined. (`null` specifically, because the case above
    // covers every other shape this validator refuses.)
    expect(parse({ tracker: { notary: { notaryUrl: null } } }).tracker.notary).toBeUndefined();
  });

  it('baseUrl: rejected without a matching host permission (no manifest in a bare test)', () => {
    // fakeBrowser's getManifest throws → hostPermissionOrigins is empty → every base URL is off-host.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = parse({ tracker: { steamEndpoints: { steamApiBaseUrl: 'https://api.steampowered.com' } } });
    expect(s.tracker.steamEndpoints?.steamApiBaseUrl).toBeUndefined();
    warn.mockRestore();
  });

  it('baseUrl: accepted when the manifest grants the origin; trailing slash still rejected', () => {
    stubManifest(['https://api.steampowered.com/*']);
    const ok = parse({ tracker: { steamEndpoints: { steamApiBaseUrl: 'https://api.steampowered.com' } } });
    expect(ok.tracker.steamEndpoints?.steamApiBaseUrl).toBe('https://api.steampowered.com');
    // The core concatenates leading-slash paths onto it, so a trailing slash would double the slash.
    const slash = parse({
      tracker: { steamEndpoints: { steamApiBaseUrl: 'https://api.steampowered.com/' } },
    });
    expect(slash.tracker.steamEndpoints?.steamApiBaseUrl).toBeUndefined();
  });

  it('baseUrl: a granted host with a non-http scheme is still rejected', () => {
    stubManifest(['https://api.steampowered.com/*']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = parse({
      tracker: { steamEndpoints: { steamApiBaseUrl: 'ftp://api.steampowered.com' } },
    });
    expect(s.tracker.steamEndpoints?.steamApiBaseUrl).toBeUndefined();
    warn.mockRestore();
  });
});

describe('leadingSlashPath — the seven overridable path fields share this guard', () => {
  const path = (v: unknown) =>
    parse({ tracker: { steamEndpoints: { getTradeOfferPath: v } } }).tracker.steamEndpoints
      ?.getTradeOfferPath;

  it('accepts a plain rooted path', () => {
    expect(path('/IEconService/GetTradeOffer/v1/')).toBe('/IEconService/GetTradeOffer/v1/');
  });

  it('rejects the shapes that move the request off its host or throw inside the core', () => {
    // `//evil.example/x` is protocol-relative; `@`+`:` shapes turn the base into userinfo; `..` climbs.
    // Six of these fields feed a core `require` (SteamHosts.requirePathKeepsHost) that would THROW
    // inside copy() — the tracker would not start — so rejection here keeps the compiled default.
    for (const bad of ['//evil.example/x', '/x/../y', '/x:1/y', 'relative/path', '', 42]) {
      expect(path(bad)).toBeUndefined();
    }
  });

  it('guards the marketplace token-refresh path too — the request that carries the 30-day credential', () => {
    const refresh = (v: unknown) =>
      parse({ tracker: { marketplaceScrape: { tokenRefreshPath: v } } }).tracker.marketplaceScrape
        ?.tokenRefreshPath;
    expect(refresh('/marketplace-api/v1/refresh-token')).toBe('/marketplace-api/v1/refresh-token');
    expect(refresh('//evil.example/refresh')).toBeUndefined();
  });
});

describe('range validators mirroring core constructor requires', () => {
  it('credential rotation knobs are narrow-only: the trigger is range-bound, the floors cannot be lowered', () => {
    const cred = (o: object) => parse({ tracker: { credentials: o } }).tracker.credentials;
    // marketplaceSessionGateHeadroomMs: 60000..600000 (may be brought in, never pushed past 10 min).
    expect(cred({ marketplaceSessionGateHeadroomMs: 120_000 })?.marketplaceSessionGateHeadroomMs).toBe(120_000);
    expect(cred({ marketplaceSessionGateHeadroomMs: 30_000 })).toBeUndefined();
    expect(cred({ marketplaceSessionGateHeadroomMs: 3_600_000 })).toBeUndefined();
    // The two refresh floors: >= 60000 only.
    expect(cred({ marketplaceRefreshMinIntervalMs: 1000 })).toBeUndefined();
    expect(cred({ marketplaceRefreshMinIntervalMs: 90_000 })?.marketplaceRefreshMinIntervalMs).toBe(90_000);
  });

  it('marketplaceSkewMs is capped at 59999 — the core requires gate headroom > skew inside copy()', () => {
    const cred = (o: object) => parse({ tracker: { credentials: o } }).tracker.credentials;
    expect(cred({ marketplaceSkewMs: 59_999 })?.marketplaceSkewMs).toBe(59_999);
    expect(cred({ marketplaceSkewMs: 60_000 })).toBeUndefined();
  });

  it('steamProfile bounds mirror SteamProfileConfig.init requires (batchSize 1..100, others >= 1)', () => {
    const prof = (o: object) => parse({ tracker: { steamProfile: o } }).tracker.steamProfile;
    expect(prof({ batchSize: 100 })?.batchSize).toBe(100);
    expect(prof({ batchSize: 0 })).toBeUndefined();
    expect(prof({ batchSize: 101 })).toBeUndefined();
    expect(prof({ maxConcurrency: 0 })).toBeUndefined();
    expect(prof({ maxRetries: 0 })).toBeUndefined();
    // MarketplaceRetryConfig.init requires maxRetries >= 1 as well.
    expect(parse({ tracker: { marketplaceRetry: { maxRetries: 0 } } }).tracker.marketplaceRetry).toBeUndefined();
  });

  it('non-integers are floored, non-finite numbers rejected', () => {
    expect(parse({ tracker: { cadence: { webPollFloorMs: 90_000.9 } } }).tracker.cadence?.webPollFloorMs).toBe(
      90_000,
    );
    expect(parse({ tracker: { cadence: { webPollFloorMs: Infinity } } }).tracker.cadence).toBeUndefined();
    expect(parse({ tracker: { cadence: { webPollFloorMs: NaN } } }).tracker.cadence).toBeUndefined();
  });
});

describe('regexWithGroup — the core reads capture group 1, silently failing without one', () => {
  const regex = (v: unknown) =>
    parse({ tracker: { steamScrape: { tokenRegex: v } } }).tracker.steamScrape?.tokenRegex;

  it('accepts a regex with a capture group', () => {
    expect(regex('token=(\\w+)')).toBe('token=(\\w+)');
  });

  it('rejects a group-less regex, a non-compiling one, and an empty string', () => {
    expect(regex('token=\\w+')).toBeUndefined();
    expect(regex('([unclosed')).toBeUndefined();
    expect(regex('')).toBeUndefined();
  });

  it('a NON-capturing group does not count', () => {
    expect(regex('token=(?:\\w+)')).toBeUndefined();
  });
});

describe('web overrides', () => {
  it('logoutExpression accepts only a bare no-arg call — the anti-injection gate for a javascript: href', () => {
    const logout = (v: unknown) => parse({ web: { logoutExpression: v } }).web.logoutExpression;
    expect(logout('SteamLogout()')).toBe('SteamLogout()');
    expect(logout('Logout();')).toBe('Logout();');
    // Every rejected shape keeps the compiled default rather than emptying the field.
    for (const bad of ['alert(1);Logout()', 'Logout(document.cookie)', 'a=1', 'Logout(); alert(1)', '']) {
      expect(logout(bad)).toBe('Logout();');
    }
  });

  it('antiCsrf entries: ruleId must be an integer >= 2, one bad entry cannot void the good ones', () => {
    // Chrome's updateSessionRules batch is atomic: a 0/negative id would silently void EVERY rule in
    // it, and id 1 is reserved for the core's per-trade rule — so bad entries are dropped here.
    const s = parse({
      web: {
        antiCsrf: [
          { ruleId: 1, host: 'steamcommunity.com', path: '/login/settoken', site: 'community' },
          { ruleId: 0, host: 'steamcommunity.com', path: '/login/settoken', site: 'community' },
          { ruleId: 7, host: 'steamcommunity.com', path: '/login/settoken', site: 'community' },
          { ruleId: 8, host: 'steamcommunity.com', path: 'no-slash', site: 'community' },
          { ruleId: 9, host: 'steamcommunity.com', path: '/x', site: 'unknown-site' },
        ],
      },
    });
    expect(s.web.antiCsrf.map((e) => e.ruleId)).toEqual([7]);
  });

  it('an antiCsrf list with NO valid entry keeps the compiled defaults instead of emptying the rules', () => {
    const s = parse({ web: { antiCsrf: [{ ruleId: 0, host: '', path: '', site: 'x' }] } });
    expect(s.web.antiCsrf.length).toBeGreaterThan(0);
  });

  it('notaryStuckAfterMs: 0 is the kill switch, any other value is floored to 5000', () => {
    expect(parse({ web: { notaryStuckAfterMs: 0 } }).web.notaryStuckAfterMs).toBe(0);
    expect(parse({ web: { notaryStuckAfterMs: 1000 } }).web.notaryStuckAfterMs).toBe(5000);
    expect(parse({ web: { notaryStuckAfterMs: 30_000 } }).web.notaryStuckAfterMs).toBe(30_000);
  });

  it('notaryProofTimeoutMs is floored at 1s — a smaller publish would abort every proof before it starts', () => {
    expect(parse({ web: { notaryProofTimeoutMs: 500 } }).web.notaryProofTimeoutMs).toBe(180_000);
    expect(parse({ web: { notaryProofTimeoutMs: 60_000 } }).web.notaryProofTimeoutMs).toBe(60_000);
  });

  it('bridgeExtraOrigins are normalised to origins and non-URLs dropped', () => {
    const s = parse({
      web: { bridgeExtraOrigins: ['https://stage.example/path?q=1', 'garbage', 42, 'wss://not-http.example'] },
    });
    expect(s.web.bridgeExtraOrigins).toEqual(['https://stage.example']);
  });
});

describe('errorReporting — remote config can only ever NARROW the reporter', () => {
  it('caps take min against the compiled default, cooldown takes max, false always wins on enabled', () => {
    const er = (o: object) => parse({ web: { errorReporting: o } }).web.errorReporting;
    // Narrowing applies…
    expect(er({ maxPerDay: 2 }).maxPerDay).toBe(2);
    expect(er({ fpCooldownMs: 3_600_000 }).fpCooldownMs).toBe(3_600_000);
    expect(er({ enabled: false }).enabled).toBe(false);
    // …widening does not: a hostile publish cannot raise volume or shorten the cooldown.
    expect(er({ maxPerDay: 1000 }).maxPerDay).toBe(10);
    expect(er({ maxPerDayFromPage: 1000 }).maxPerDayFromPage).toBe(3);
    expect(er({ fpCooldownMs: 1 }).fpCooldownMs).toBe(1_800_000);
  });

  it('suppressSubstrings are bounded in count and length (no remote regex — ReDoS surface)', () => {
    const many = Array.from({ length: 50 }, (_, i) => `sub-${i}`);
    const s = parse({ web: { errorReporting: { suppressSubstrings: [...many, 'x'.repeat(200), 42] } } });
    expect(s.web.errorReporting.suppressSubstrings).toHaveLength(32);
    expect(s.web.errorReporting.suppressSubstrings.every((v) => v.length <= 120)).toBe(true);
  });
});

describe('snapshot + reactivity (loadSettings / subscribeSettings / cookie-name getters)', () => {
  it('cookie-name getters answer the compiled mirrors by default and the override after a load', async () => {
    await publishRemoteConfig({});
    expect(getMarketplaceCookieName()).toBe('dm-trade-token');
    expect(getSteamSessionCookieName()).toBe('steamLoginSecure');

    await publishRemoteConfig({
      tracker: {
        marketplaceScrape: { cookieName: 'dm-alt-token' },
        steamScrape: { steamSessionCookieName: 'altLoginSecure' },
      },
    });
    expect(getMarketplaceCookieName()).toBe('dm-alt-token');
    expect(getSteamSessionCookieName()).toBe('altLoginSecure');

    // Restore the module-level snapshot for other tests in this file (it is a singleton).
    await publishRemoteConfig({});
  });

  it('subscribeSettings reloads on a cache change and ignores other keys', async () => {
    const seen: string[] = [];
    const unsubscribe = subscribeSettings((s) => seen.push(s.web.dmarketUrl));

    await browser.storage.local.set({ 'unrelated.key': 1 });
    await flushMacrotasks();
    expect(seen).toEqual([]);

    await publishRemoteConfig({ web: { dmarketUrl: 'https://dm.example/' } });
    await vi.waitFor(() => expect(seen).toEqual(['https://dm.example/']));

    unsubscribe();
    await publishRemoteConfig({});
    await flushMacrotasks();
    expect(seen).toHaveLength(1);
  });
});
