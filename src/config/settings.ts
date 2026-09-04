// Remote-config overlay: the single seam that turns the fetched Remote Config document into typed,
// validated settings, merged over the compiled-in / core defaults.
//
// Shape: ONE Remote Config parameter (`p2p_tracker_config`) holds one JSON document so iOS/Android
// clients reuse the exact same config. Its `tracker` object mirrors the core `TrackerConfig` 1:1
// (camelCase field names = the core's @JsExport property names), and `web` carries web-extension-only
// extras (banner injection, anti-CSRF endpoints, timings) that other clients ignore.
//
// Every field is optional; a missing / malformed / out-of-range field falls back to its default and is
// dropped from the overlay — this layer NEVER throws (a bad remote value must not brick the tracker).
// Two core groups validate in their constructors (`MarketplaceRetryConfig`, `SteamProfileConfig`), so
// their bounds are enforced here BEFORE the value reaches the core `.copy()`. Host / base-URL overrides
// are additionally gated on the extension's own `host_permissions` (a host the manifest can't reach, or
// that the core's hardcoded allow-lists reject, is ignored + warned) — see docs and the plan.
//
// `getSettings()` is a synchronous snapshot (defaults until the first async load); each context (service
// worker, popup, content script) calls `initSettings()` once to load + keep it live via
// storage.onChanged on the Remote Config cache.

import {
  CADENCE_ORDER,
  CREDENTIAL_ORDER,
  GAME_ORDER,
  HTTP_ORDER,
  MARKETPLACE_RETRY_ORDER,
  NOTARY_ORDER,
  STEAM_ENDPOINTS_ORDER,
  STEAM_PROFILE_ORDER,
  STEAM_SCRAPE_ORDER,
  type CoreOnlyEndpointParam,
  type CoreOnlyNotaryParam,
} from '@/config/coreParams';
import { STEAM_INTEGRATION, type AntiCsrfEndpoint } from '@/config/steam';
import {
  readCachedEntries,
  REMOTE_CONFIG_CACHE_KEY,
  REMOTE_CONFIG_PARAM,
  type ConfigEntries,
} from '@/infra/remoteConfig';
import { onStorageChanged } from '@/util/storageEvents';

// ---- Compiled-in defaults ---------------------------------------------------------------------------
// The single home for every extension-owned default value. Steam-coupled defaults live in
// src/config/steam.ts (STEAM_INTEGRATION) and are pulled into defaultWeb() below; everything else is
// defined here. Consumers never define their own local fallbacks — they read the resolved snapshot
// (getSettings()) or import the constant from here.

/**
 * The DMarket page origins. Feeds the page bridge's cross-window origin allow-list and the
 * mismatch-push tab patterns (`origin + '/*'`). NOTE: the dmarket-bridge content script's `matches`
 * must stay an inline literal (WXT statically analyses it at build time) — keep the two in sync.
 */
export const DMARKET_ORIGINS = ['https://dmarket.com', 'https://www.dmarket.com'];

/**
 * The DMarket site the user opens to restore a missing DMarket session (re-issues the marketplace
 * cookie the core reads). Prod origin — dev builds still point the core itself at an internal dev FE
 * via the debug console. Remote-overridable as `web.dmarketUrl`.
 */
const DMARKET_URL = 'https://dmarket.com/';

/** DMarket deep-link shown in the "Trade tracking is ON" Steam banner. Remote-overridable. */
const ACTIVE_BANNER_LINK = 'https://dmarket.com/ingame-items/item-list/csgo-skins';

/** Debounce for the forced-heartbeat reconnect/refresh triggers (ms). Remote-overridable. */
const DEBOUNCE_MS = 3000;

/**
 * How long to wait for one TLSN proof before giving up on it (ms). Remote-overridable, because the real
 * figure can only come from a measurement against a live notary.
 *
 * A bound is what matters, not the value. Nothing on the proof path had one: the notary and proxy
 * WebSockets reject on error/close but a socket stuck in CONNECTING emits neither, so an unreachable notary
 * hung the proof — and with it the tracker cycle, which awaits it inline. Observed live: a cycle reported at
 * 09:19:21 and then emitted nothing at all, no ProofFailed and no CycleCompleted. Worse, the prover's
 * `Semaphore(maxConcurrency)` means two such hangs block every later proof for the life of the worker.
 *
 * **180s, raised from 60s, because 60s was below the floor rather than generous.** The measurement that
 * settled it: one healthy proof closed its notary socket having sent **63.4 MB** and received 4.07 MB, in
 * 17.8s — roughly 3.5 MB/s sustained. That is what the bound has to cover, and at 1 MB/s the very same proof
 * needs ~63s, so a bandwidth dip alone put it over the old ceiling. Observed live: three consecutive attempts
 * reached Steam's first TLS flight through the proxy and were then killed mid-MPC at exactly 60 000 ms, none
 * of them a hang — every one of them work in progress. Each kill also costs a fresh ~10 MB WASM compile and a
 * fresh MPC preprocessing round on the notary, so a ceiling set too low makes the next attempt *less* likely
 * to fit.
 *
 * A bound is still what matters, and the failure it exists for is unchanged: the sockets reject on
 * error/close, but one stuck in CONNECTING emits neither, so an unreachable notary hangs the proof for as
 * long as this value — now three minutes of a wedged cycle. That is the price of not killing live work, and
 * the `ws#N PROGRESS` traces (see `entrypoints/offscreen/prover-worker.ts`) are what tells the two apart
 * without waiting for the deadline.
 */
const NOTARY_PROOF_TIMEOUT_MS = 180_000;

/**
 * How long the prover's driver may ignore a liveness ping before the offscreen document declares it wedged
 * and recycles the worker (ms). `0` disables the watch. Remote-overridable as `web.notaryStuckAfterMs`.
 *
 * This is the inner, cheap half of the bound above. {@link NOTARY_PROOF_TIMEOUT_MS} has to be generous
 * because it cannot tell a slow MPC from a stuck one — but the driver blocks its worker thread on
 * `Atomics.wait`, so a *wedged* prover cannot answer a `postMessage` while a merely slow one answers every
 * time. Probing turns three minutes of a blocked tracker cycle into ~25 s, which matters twice over: the
 * cycle awaits the proof inline, so a 180 s wedge also skipped a whole heartbeat (`ttlSeconds` is 92).
 *
 * 25 s against measurements: a healthy proof finishes its entire Steam exchange within ~14 s of the target
 * socket opening and the whole issuance in ~16 s, while the driver's normal blocking was observed to delay a
 * 5 s timer by 0.1-0.6 s. So the gap between "briefly blocked" and "wedged" is two orders of magnitude, and
 * 25 s sits in it with room for a much slower machine.
 *
 * Remote-settable for the same reason the timeout is, and the direction that hurts is DOWN: a value below the
 * real blocking envelope would kill healthy proofs on slow hardware — every proof, permanently, from one
 * publish. Hence the floor in {@link buildWeb}, and `0` for an outright kill switch if it ever misfires.
 */
const NOTARY_STUCK_AFTER_MS = 25_000;

/** Floor for a non-zero {@link NOTARY_STUCK_AFTER_MS} override: below the probe interval it cannot work. */
const NOTARY_STUCK_FLOOR_MS = 5_000;

/**
 * How many proofs one wasm instance serves before the offscreen document recycles it. `0` never recycles.
 * Remote-overridable as `web.notaryProofsPerInstance`.
 *
 * **5 → was 1, and the 1 was built on a single sample that later evidence refuted.** Per-proof recycling was
 * added when a wedge on the *second* proof of a warm realm looked like stale instance state; its own comment
 * conceded "one sample cannot prove the reuse was the cause". It cannot: across 22 attempts on 2026-08-26 the
 * wedge hit `worker=created` as readily as `worker=reused`, and the one variable that separated every success
 * from every failure was whether the target socket ever delivered its upstream close — which has nothing to do
 * with instance age.
 *
 * What per-proof recycling does cost is real and paid on every attempt: a ~10 MB wasm fetch + compile, plus a
 * fresh rayon pool. On a QA machine tracking 10 proof-required deals that is continuous, and the MPC setup
 * phase there ran 11-44 s against ~5 s on a lightly loaded one — which is why CPU pressure is now a live
 * hypothesis for the wedge itself rather than merely a cost.
 *
 * 5 is upstream's own guidance (tlsn #959, "re-init every 5 proofs"), so this keeps the hygiene the recycle
 * was reaching for and stops paying for it five times over. Remote-settable in both directions: publish `1` to
 * restore the old behaviour without a release if reuse turns out to matter after all.
 */
const NOTARY_PROOFS_PER_INSTANCE = 5;

/**
 * Compiled defaults for the crash reporter (src/infra/report/). Remote config may only ever NARROW these —
 * see the clamping in {@link buildErrorReporting}.
 *
 * This group deliberately has no `*_SCHEMA` / {@link pickGroup} pass like the tracker groups do: those
 * validate a value and then take it, which is the wrong shape here. Every field is folded against the
 * compiled default instead (`Math.min` on the budgets, `Math.max` on the cooldown, `false` always winning
 * on `enabled`), so a publish can tighten the reporter but never loosen it.
 */
const ERROR_REPORTING_DEFAULTS = {
  enabled: true,
  /** Reports per UTC day from the extension's own code. */
  maxPerDay: 10,
  /**
   * Reports per UTC day whose input came from the web page (the dmarket.com bridge). A separate, much
   * smaller bucket so a rogue script or an XSS on dmarket.com cannot exhaust the internal budget and blind
   * the reporter for the rest of the day.
   */
  maxPerDayFromPage: 3,
  /** Per-fingerprint cooldown; the occurrence ladder still lets 1/2/4/8… through. */
  fpCooldownMs: 1_800_000,
  /** Extra suppression substrings, MERGED with the compiled list — never replacing it. */
  suppressSubstrings: [] as string[],
} as const;

/**
 * Mirror of the core's default `MarketplaceScrapeConfig.cookieName` — the DMarket session cookie.
 * The core owns the real default; this copy exists only for the extension's own cookie watch
 * (src/background/refresh.ts) when no remote override is present. Resolved via
 * {@link getMarketplaceCookieName}, never imported directly.
 */
const MARKETPLACE_COOKIE_NAME = 'dm-trade-token';

/**
 * Mirror of the core's default `SteamScrapeConfig.steamSessionCookieName` — the Steam session cookie.
 * The core owns the real default; this copy exists only for the extension's own cookie watch
 * (src/background/refresh.ts) and the dev console's traffic-light when no remote override is present.
 * Resolved via {@link getSteamSessionCookieName}, never imported directly.
 */
const STEAM_SESSION_COOKIE_NAME = 'steamLoginSecure';

// ---- Public shapes --------------------------------------------------------------------------------

/** Partial overrides for the core TrackerConfig groups the extension can apply (see core-domain.d.ts).
 *  `backoff` is intentionally absent (its KtList fields aren't constructible from JS). */
export interface TrackerOverrides {
  cadence?: CadenceOverrides;
  credentials?: CredentialOverrides;
  http?: { requestTimeoutMs?: number };
  marketplaceRetry?: { maxRetries?: number; retryBaseDelayMs?: number; retryMaxDelayMs?: number };
  // refreshUrl / tokenRefreshUrl are the extension's own endpoints (env + debug console), never RC — a
  // remote value there would redirect the request that carries the 30-day refresh credential.
  marketplaceScrape?: {
    cookieName?: string;
    refreshCookieName?: string;
    tokenRefreshPath?: string;
    deferRefreshWhileSiteTabOpen?: boolean;
  };
  notary?: NotaryOverrides;
  steamEndpoints?: SteamEndpointsOverrides;
  steamProfile?: SteamProfileOverrides;
  steamScrape?: SteamScrapeOverrides;
  game?: { cs2InventoryContextId?: number };
}

export interface CadenceOverrides {
  activeOfferIntervalMs?: number;
  revertWatchIntervalMs?: number;
  maxActionDelayMs?: number;
  webPollFloorMs?: number;
  iosForegroundPollFloorMs?: number;
  iosBackgroundPollFloorMs?: number;
  androidForegroundPollFloorMs?: number;
  androidBackgroundPollFloorMs?: number;
  webHeartbeatFloorMs?: number;
  iosForegroundHeartbeatFloorMs?: number;
  iosBackgroundHeartbeatFloorMs?: number;
  androidForegroundHeartbeatFloorMs?: number;
  androidBackgroundHeartbeatFloorMs?: number;
  expeditedOfferIntervalMs?: number;
  expeditedWindowMs?: number;
  /** Heartbeat interval (ms) used only when the backend sends no ttl_seconds; a backend ttl always wins. */
  fallbackHeartbeatIntervalMs?: number;
}

export interface CredentialOverrides {
  steamSkewMs?: number;
  marketplaceSkewMs?: number;
  sessionGateHeadroomMs?: number;
  marketplaceSessionGateHeadroomMs?: number;
  marketplaceRefreshMinLifeMs?: number;
  marketplaceRefreshMinIntervalMs?: number;
}

export interface SteamScrapeOverrides {
  tokenRegex?: string;
  steamIdRegex?: string;
  steamSessionCookieName?: string;
  steamSessionIdCookieName?: string;
}

export interface SteamProfileOverrides {
  cacheTtlMs?: number;
  maxConcurrency?: number;
  batchSize?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export interface SteamEndpointsOverrides {
  steamApiBaseUrl?: string;
  getTradeOfferPath?: string;
  getTradeOffersPath?: string;
  getTradeHistoryPath?: string;
  getPlayerSummariesPath?: string;
  getSteamLevelPath?: string;
  loginBaseUrl?: string;
  communityBaseUrl?: string;
  storeBaseUrl?: string;
  historyMaxTrades?: number;
  bulkOfferThreshold?: number;
  paramAccessToken?: string;
  paramTradeOfferId?: string;
  paramGetSentOffers?: string;
  paramActiveOnly?: string;
  paramGetDescriptions?: string;
  paramMaxTrades?: string;
  paramSteamIds?: string;
  paramSteamId?: string;
  /**
   * Asks the bulk offer list for received offers too, so a deal this account is *buying* (whose Steam
   * offer is a received one) resolves from the batch instead of a per-offer read. Listed last to mirror
   * the core's own parameter order, which is append-only because `copy()` is positional.
   */
  paramGetReceivedOffers?: string;
}

export interface NotaryOverrides {
  maxConcurrency?: number;
  /** Redirects the prover at another notary. Not nullable: see `resolveNotaryUrl` for what a clear does. */
  notaryUrl?: string;
  subprotocol?: string;
  maxSentData?: number;
  maxRecvData?: number;
  threadCount?: number;
  provenCookieHeader?: string;
  /**
   * PEM roots the prover verifies the TARGET's chain against, so a harness substrate presenting a fixture-CA
   * leaf for `api.steampowered.com` can be proven at all. Set from a DEV-ONLY build-time variable, never from
   * remote config — it is a trust anchor, so it keeps a `rejectAlways` validator in NOTARY_SCHEMA rather than
   * leaving the type (which is what closes the remote channel while leaving the local one open; the fields
   * that have no local setter either are gone from this interface entirely — see `CoreOnlyNotaryParam`).
   */
  rootStorePem?: string;
  /**
   * Response bytes preprocessed for **online** decryption; everything past it is decrypted deferred.
   *
   * The knob under active measurement — walked through 32 / 1024 / 2048 / 4096 against live proofs, at roughly
   * 10 MB of extra upload per KB — and until now unreachable from remote config, so every step cost a core
   * release. Bounded above by `maxRecvData` **in the core**, whose constructor throws on a config asking to
   * preprocess online more bytes than the record layer will receive: publish the two together, or leave the
   * ceiling alone and stay under it.
   */
  maxRecvDataOnline?: number;
  /**
   * Response **records** preprocessed for online decryption — the record-count sibling of
   * `maxRecvDataOnline`, new on the vendored prover and the reason this group's order runs to slot 17.
   *
   * **Absent does not mean zero.** Upstream documents no default for it, so the core sends no key at all while
   * this is unset and the prover keeps its own contract default. Publishing a number replaces that default
   * with one nobody has measured — which is exactly the point (it makes the measurement possible without a
   * release), and exactly why unset is the safe state.
   */
  maxRecvRecordsOnline?: number;
  /**
   * Headroom in percent over the **computed** send-transcript requirement.
   *
   * The core no longer sends a flat `maxSentData`: `ProvenSentBudget` sizes the send budget to the request it
   * can derive — 103 B of HTTP framing plus the read's own path plus the token — times this margin, clamped at
   * the configured `maxSentData`, for any token-authed read with no headers, no body and no per-read override.
   * On the history axis that is the `196 + len(steamAccessToken)` the core measured: the observed 522-char
   * token needs 718 B and the compiled 15 admits 826 against a flat 1024 — worth roughly 2 MB less MPC
   * pre-processing per proof on a ~41 MB session.
   *
   * **Settable because it is the rollback, not because it is a dial.** A send budget that comes up short fails
   * EVERY proof, so if a Steam-side change makes the computed requirement wrong, the fix has to be available
   * without an extension release: publishing anything >= 44 pushes the computed budget back over `maxSentData`,
   * where it clamps, and the sizing stops applying at all. That is why this one is `number` while
   * `onlineBudgetMarginPercent` — the same shape of knob, one with no comparable failure mode — is not on this
   * interface at all (`CoreOnlyNotaryParam`).
   *
   * Validated `int(0)`: the core requires `>= 0` and there is no sensible ceiling, since a large value is not
   * a dangerous value, it is the off position.
   */
  sentBudgetMarginPercent?: number;
}

/** Web-extension-only settings (fully resolved: defaults with any valid overrides applied). */
interface WebSettings {
  bannerAnchorSelector: string;
  logoutExpression: string;
  tradeOffersUrl: string;
  steamLoginUrl: string;
  activeBannerLink: string;
  antiCsrf: AntiCsrfEndpoint[];
  reconnectDebounceMs: number;
  refreshDebounceMs: number;
  /** Give up on a single TLSN proof after this long (ms) — see NOTARY_PROOF_TIMEOUT_MS. */
  notaryProofTimeoutMs: number;
  /** Treat the prover's driver as wedged after this long without a pong (ms); `0` disables the watch. */
  notaryStuckAfterMs: number;
  /** Proofs one wasm instance serves before recycling; `0` never recycles — see NOTARY_PROOFS_PER_INSTANCE. */
  notaryProofsPerInstance: number;
  dmarketUrl: string;
  bridgeExtraOrigins: string[];
  errorReporting: ErrorReportingSettings;
}

/** Crash-reporter knobs. Every one of them can only reduce what is collected. */
interface ErrorReportingSettings {
  enabled: boolean;
  maxPerDay: number;
  maxPerDayFromPage: number;
  fpCooldownMs: number;
  suppressSubstrings: string[];
}

interface Settings {
  /** Partial core-config overrides (empty groups omitted); consumed by the seam to build a TrackerConfig. */
  tracker: TrackerOverrides;
  /** Fully-resolved web-extension settings. */
  web: WebSettings;
}

/** The fully-resolved web defaults (Steam-coupled values from STEAM_INTEGRATION, the rest from the
 *  defaults section above). A fresh object per call — the overlay mutates its copy. */
function defaultWeb(): WebSettings {
  return {
    bannerAnchorSelector: STEAM_INTEGRATION.bannerAnchorSelector,
    logoutExpression: STEAM_INTEGRATION.logout.expression,
    tradeOffersUrl: STEAM_INTEGRATION.tradeOffersUrl,
    steamLoginUrl: STEAM_INTEGRATION.loginUrl,
    activeBannerLink: ACTIVE_BANNER_LINK,
    antiCsrf: STEAM_INTEGRATION.antiCsrf.map((e) => ({ ...e })),
    reconnectDebounceMs: DEBOUNCE_MS,
    refreshDebounceMs: DEBOUNCE_MS,
    notaryProofTimeoutMs: NOTARY_PROOF_TIMEOUT_MS,
    notaryStuckAfterMs: NOTARY_STUCK_AFTER_MS,
    notaryProofsPerInstance: NOTARY_PROOFS_PER_INSTANCE,
    dmarketUrl: DMARKET_URL,
    bridgeExtraOrigins: [],
    errorReporting: { ...ERROR_REPORTING_DEFAULTS, suppressSubstrings: [] },
  };
}

const DEFAULTS: Settings = { tracker: {}, web: defaultWeb() };

// ---- Field validators (each returns the value or `undefined` to reject → keep default) ------------

interface Ctx {
  /** Origins the manifest already declares in host_permissions (for host/base-URL override guarding). */
  origins: Set<string>;
}
type Validator = (v: unknown, ctx: Ctx) => unknown;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function int(min: number, max?: number): Validator {
  return (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    const n = Math.floor(v);
    if (n < min) return undefined;
    if (max !== undefined && n > max) return undefined;
    return n;
  };
}

const nonEmptyStr: Validator = (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/**
 * Always `undefined` — the key exists for its POSITION in a `*_ORDER` array and must never be settable from
 * remote config. `pickGroup` drops an `undefined`, so a published value is silently ignored and the core
 * keeps its compiled default, which is the intended outcome for a field like this.
 */
const rejectAlways: Validator = () => undefined;

// A bare no-argument call expression like `Logout();` — the ONLY safe shape for `web.logoutExpression`,
// which is concatenated into a `javascript:` href and runs in the Steam page's main world. This lets a
// remote value rename the logout global but NOT inject arbitrary script (no args, operators, or extra
// statements). Anything else is rejected → the compiled default (`Logout();`) is kept.
const callExpression: Validator = (v) =>
  typeof v === 'string' && /^[A-Za-z_$][\w$]*\(\s*\)\s*;?$/.test(v) ? v : undefined;

/**
 * A rooted path that cannot move the request off its base host.
 *
 * `startsWith('/')` alone is not enough, and the fields this guards are the reason: each is concatenated onto a
 * base URL in the core, and six of them then hit `SteamEndpointsConfig.init` → `SteamHosts.requirePathKeepsHost`,
 * which is a `require` — so a published value like `//evil.example/x` (protocol-relative) or `@evil.example/x`
 * (the base becomes userinfo) does not merely misroute, it THROWS inside `copy()` while `buildTrackerConfig`
 * has no guard, i.e. the tracker does not start. Rejecting it here keeps the compiled default instead.
 */
const leadingSlashPath: Validator = (v) =>
  typeof v === 'string' &&
  v.startsWith('/') &&
  !v.startsWith('//') &&
  !v.includes(':') &&
  !v.includes('..')
    ? v
    : undefined;

const boolean: Validator = (v) => (typeof v === 'boolean' ? v : undefined);

/** A regex string that compiles AND exposes at least one capture group (the core reads group 1). */
const regexWithGroup: Validator = (v) => {
  if (typeof v !== 'string' || v === '') return undefined;
  try {
    // Appending `|` makes an empty match succeed; the match array length minus the full match = groups.
    const groups = new RegExp(`${v}|`).exec('')!.length - 1;
    return groups >= 1 ? v : undefined;
  } catch {
    return undefined;
  }
};

/** http(s) base URL with NO trailing slash (the core concatenates leading-slash paths), gated on
 *  host_permissions — a host the manifest can't reach (or the core's allow-lists reject) is ignored. */
const baseUrl: Validator = (v, ctx) => {
  if (typeof v !== 'string' || v === '' || v.endsWith('/')) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
  if (!ctx.origins.has(u.origin)) {
    console.warn(`[dmarket-p2p] remote config: base URL "${v}" is outside host_permissions — ignored`);
    return undefined;
  }
  return v;
};

// A bare-host validator lived here (`guardedHost`), gated on host_permissions via its https origin. Its only
// ever consumer was `notary.provenServerName`, which stopped being publishable and has since been folded into
// the core-only `ProvenRead` group, and no other overridable field is a bare host — every other host-shaped
// value is a full URL and goes through `baseUrl` above. Deleted rather than left dangling; restore it from git
// if a bare-host field returns.

/** wss:// (or ws://) URL — notary transport; not host_permissions-gated. */
const wssUrl: Validator = (v) => {
  if (typeof v !== 'string' || v === '') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'wss:' || u.protocol === 'ws:' ? v : undefined;
  } catch {
    return undefined;
  }
};

/** http(s) URL (not host_permissions-gated — used for tab-open targets / banner links). */
const httpUrl: Validator = (v) => {
  if (typeof v !== 'string' || v === '') return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? v : undefined;
  } catch {
    return undefined;
  }
};

// ---- Group schemas (field name → validator). Fields absent from the raw object keep their default. --
//
// Each schema is pinned to its group's parameter order from @/config/coreParams, so the two lists cannot
// drift. That is load-bearing rather than tidy: a name present in the order (and therefore in the core's
// positional `copy()`) but missing here used to compile, and the override would be silently dropped by
// {@link pickGroup} — the operator sees a published key that never takes effect. Now it is a build error.
//
// `Schema<K>` keeps the mapping keyed instead of `Record<string, Validator>`: an index-signature type
// accepts anything, which is exactly how a missing key went unnoticed.

type Schema<K extends string> = Record<K, Validator>;

/** Every parameter in `keys` as a non-negative-integer (ms) field. Keyed by the tuple, so the returned
 *  schema covers the order exactly — no key can be forgotten and none can be invented. */
const allIntMs = <K extends string>(keys: readonly K[]): Schema<K> =>
  Object.fromEntries(keys.map((k) => [k, int(0)])) as Schema<K>;

const CADENCE_SCHEMA = allIntMs(CADENCE_ORDER);

// NOT `allIntMs`: the three DMarket refresh knobs bound how often this client may rotate a credential it
// shares with the user's browser session, so remote config must only ever be able to **narrow** them. `int(0)`
// would let one publish turn the rotation rate up, and the remote document is delivered to every client over
// an unauthenticated public REST call.
//
// Expressed as ranges rather than a post-pass of `Math.min`/`Math.max`, because the two are the same thing
// here: the bound to clamp against IS the compiled default, and a field dropped by the validator means
// `withOverrides` never passes it, so the core uses that same default. A range says it in the one place every
// other field's range already lives, with nothing to keep in sync.
//
// `marketplaceSkewMs` is bounded ABOVE for a different reason: it is the one cross-field invariant the core
// enforces with a `require` (`marketplaceSessionGateHeadroomMs > marketplaceSkewMs`), which would throw inside
// `copy()` — and `buildTrackerConfig` has no guard, so the tracker would not start.
const CREDENTIAL_SCHEMA = {
  steamSkewMs: int(0),
  marketplaceSkewMs: int(0, 59_999),
  sessionGateHeadroomMs: int(0),
  // Refresh trigger: may be brought in, never pushed out past the compiled 10 min. Floor mirrors the core's
  // own `require(... >= 60_000)`.
  marketplaceSessionGateHeadroomMs: int(60_000, 600_000),
  // Both floors may be raised, never lowered — the compiled value is the minimum.
  marketplaceRefreshMinLifeMs: int(60_000),
  marketplaceRefreshMinIntervalMs: int(60_000),
} satisfies Schema<(typeof CREDENTIAL_ORDER)[number]>;

const HTTP_SCHEMA = { requestTimeoutMs: int(1) } satisfies Schema<(typeof HTTP_ORDER)[number]>;

// MarketplaceRetryConfig.init requires maxRetries >= 1 (else the core constructor THROWS).
const MARKETPLACE_RETRY_SCHEMA = {
  maxRetries: int(1),
  retryBaseDelayMs: int(0),
  retryMaxDelayMs: int(0),
} satisfies Schema<(typeof MARKETPLACE_RETRY_ORDER)[number]>;

// Deliberately NOT pinned to MARKETPLACE_SCRAPE_ORDER: two of its slots (`refreshUrl`, `tokenRefreshUrl`)
// are the extension's own endpoints (env / debug console) and must never be settable from remote config.
//
// `tokenRefreshPath` IS remote-overridable — a path is the safe class of remote hotfix, a host is not — and it
// goes through the same `leadingSlashPath` guard as every other overridable path. The core additionally
// allow-lists the origin the resolved URL lands on, since this is the one request whose body carries the
// ~30-day refresh credential; this is the first of those two gates.
const MARKETPLACE_SCRAPE_SCHEMA = {
  cookieName: nonEmptyStr,
  refreshCookieName: nonEmptyStr,
  tokenRefreshPath: leadingSlashPath,
  deferRefreshWhileSiteTabOpen: boolean,
} satisfies Schema<'cookieName' | 'refreshCookieName' | 'tokenRefreshPath' | 'deferRefreshWhileSiteTabOpen'>;

// SteamProfileConfig.init requires batchSize in 1..100, maxConcurrency >= 1, maxRetries >= 1.
const STEAM_PROFILE_SCHEMA = {
  cacheTtlMs: int(0),
  maxConcurrency: int(1),
  batchSize: int(1, 100),
  requestTimeoutMs: int(1),
  maxRetries: int(1),
  retryBaseDelayMs: int(0),
  retryMaxDelayMs: int(0),
} satisfies Schema<(typeof STEAM_PROFILE_ORDER)[number]>;

const STEAM_SCRAPE_SCHEMA = {
  tokenRegex: regexWithGroup,
  steamIdRegex: regexWithGroup,
  steamSessionCookieName: nonEmptyStr,
  steamSessionIdCookieName: nonEmptyStr,
} satisfies Schema<(typeof STEAM_SCRAPE_ORDER)[number]>;

// The core-only slots are excluded: they exist in the order only to hold their position.
const STEAM_ENDPOINTS_SCHEMA = {
  steamApiBaseUrl: baseUrl,
  getTradeOfferPath: leadingSlashPath,
  getTradeOffersPath: leadingSlashPath,
  getTradeHistoryPath: leadingSlashPath,
  getPlayerSummariesPath: leadingSlashPath,
  getSteamLevelPath: leadingSlashPath,
  loginBaseUrl: baseUrl,
  communityBaseUrl: baseUrl,
  storeBaseUrl: baseUrl,
  historyMaxTrades: int(1),
  bulkOfferThreshold: int(0),
  paramAccessToken: nonEmptyStr,
  paramTradeOfferId: nonEmptyStr,
  paramGetSentOffers: nonEmptyStr,
  paramActiveOnly: nonEmptyStr,
  paramGetDescriptions: nonEmptyStr,
  paramMaxTrades: nonEmptyStr,
  paramSteamIds: nonEmptyStr,
  paramSteamId: nonEmptyStr,
  paramGetReceivedOffers: nonEmptyStr,
} satisfies Schema<Exclude<(typeof STEAM_ENDPOINTS_ORDER)[number], CoreOnlyEndpointParam>>;

const NOTARY_SCHEMA = {
  maxConcurrency: int(1),
  notaryUrl: wssUrl,
  subprotocol: nonEmptyStr,
  maxSentData: int(1),
  maxRecvData: int(1),
  threadCount: int(1),
  provenCookieHeader: nonEmptyStr,
  // The ONE key here that is refused rather than validated, and the only reason `rejectAlways` still exists:
  // every other unpublishable parameter of this group is off `NotaryOverrides` altogether and so has no entry
  // (see `CoreOnlyNotaryParam`). `rootStorePem` cannot follow them, because the extension itself sets it —
  // from a dev-only build-time variable — so the type has to keep it and only the remote channel closes here.
  //
  // It is a TRUST ANCHOR: a published value plus control of the byte pipe would let the prover accept a forged
  // `api.steampowered.com` and attest it. The verifier checks the chain against its own roots, so such a proof
  // is rejected downstream — defence in depth, not a reason to put the anchor on a config channel.
  rootStorePem: rejectAlways,
  // The two the order was extended to reach. Both are `int(1)`: a zero online budget is not "disable the
  // preprocessing", it is a budget that cannot hold one record — the shape of the deterministic
  // `record layer error` a 32 B value produced, arrived at from the other direction.
  //
  // Neither is range-capped here, deliberately. The ceiling for the byte budget is `maxRecvData`, which the
  // CORE enforces by throwing, so a capping rule copied here would be a second, drifting statement of it. For
  // the record budget nobody knows what a sane maximum is — that is the thing being measured — and a guessed
  // cap would refuse the run that would answer it.
  maxRecvDataOnline: int(1),
  maxRecvRecordsOnline: int(1),
  // `int(0)`, and both ends of that are deliberate. The floor is the core's own `require(>= 0)`, so a negative
  // publish would throw inside `copy()` — and `buildTrackerConfig` has no guard, so the tracker would not
  // start. There is no ceiling because a large value is not the dangerous direction: the computed send budget
  // is clamped at `maxSentData`, so anything >= 44 simply reinstates the flat budget. That IS the rollback
  // this slot was opened for (an undersized send budget fails every proof at once), and a guessed cap is how
  // the one publish that had to work would get refused.
  //
  // Unlike every other key here, the installed core does not accept this argument yet — see `PENDING` in
  // scripts/check-core-params.mjs. Publishing it before that lands is inert, not harmful: `withOverrides`
  // passes one extra positional argument and the generated `copy()` ignores arguments past its arity.
  sentBudgetMarginPercent: int(0),
} satisfies Schema<Exclude<(typeof NOTARY_ORDER)[number], CoreOnlyNotaryParam>>;

const GAME_SCHEMA = { cs2InventoryContextId: int(0) } satisfies Schema<(typeof GAME_ORDER)[number]>;

// ---- Parsing / overlay ----------------------------------------------------------------------------

/** Validate the known fields of one raw group object; returns `undefined` when nothing valid remains. */
function pickGroup<T>(raw: unknown, schema: Record<string, Validator>, ctx: Ctx): T | undefined {
  if (!isObj(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, validate] of Object.entries(schema)) {
    if (!(key in raw)) continue;
    const value = validate(raw[key], ctx);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as T) : undefined;
}

function buildTracker(raw: Record<string, unknown>, ctx: Ctx): TrackerOverrides {
  const t: TrackerOverrides = {};
  const cadence = pickGroup<CadenceOverrides>(raw.cadence, CADENCE_SCHEMA, ctx);
  const credentials = pickGroup<CredentialOverrides>(raw.credentials, CREDENTIAL_SCHEMA, ctx);
  const http = pickGroup<{ requestTimeoutMs?: number }>(raw.http, HTTP_SCHEMA, ctx);
  const marketplaceRetry = pickGroup<TrackerOverrides['marketplaceRetry']>(
    raw.marketplaceRetry,
    MARKETPLACE_RETRY_SCHEMA,
    ctx,
  );
  const marketplaceScrape = pickGroup<NonNullable<TrackerOverrides['marketplaceScrape']>>(
    raw.marketplaceScrape,
    MARKETPLACE_SCRAPE_SCHEMA,
    ctx,
  );
  const notary = pickGroup<NotaryOverrides>(raw.notary, NOTARY_SCHEMA, ctx);
  const steamEndpoints = pickGroup<SteamEndpointsOverrides>(raw.steamEndpoints, STEAM_ENDPOINTS_SCHEMA, ctx);
  const steamProfile = pickGroup<SteamProfileOverrides>(raw.steamProfile, STEAM_PROFILE_SCHEMA, ctx);
  const steamScrape = pickGroup<SteamScrapeOverrides>(raw.steamScrape, STEAM_SCRAPE_SCHEMA, ctx);
  const game = pickGroup<{ cs2InventoryContextId?: number }>(raw.game, GAME_SCHEMA, ctx);
  if (cadence) t.cadence = cadence;
  if (credentials) t.credentials = credentials;
  if (http) t.http = http;
  if (marketplaceRetry) t.marketplaceRetry = marketplaceRetry;
  if (marketplaceScrape) t.marketplaceScrape = marketplaceScrape;
  if (notary) t.notary = notary;
  if (steamEndpoints) t.steamEndpoints = steamEndpoints;
  if (steamProfile) t.steamProfile = steamProfile;
  if (steamScrape) t.steamScrape = steamScrape;
  if (game) t.game = game;
  return t;
}

function validAntiCsrf(raw: unknown): AntiCsrfEndpoint[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AntiCsrfEndpoint[] = [];
  for (const e of raw) {
    if (!isObj(e)) continue;
    const ruleId = e.ruleId;
    const host = e.host;
    const path = e.path;
    const site = e.site;
    // ruleId must be an integer >= 2: Chrome DNR requires ids >= 1, and id 1 is reserved for the core's
    // per-trade send rule. A bad id (0/negative/1) is dropped here — NOT passed through — because an
    // invalid id would make Chrome reject the entire atomic updateSessionRules batch, silently voiding
    // every other (valid) endpoint override in the same list.
    if (typeof ruleId !== 'number' || !Number.isInteger(ruleId) || ruleId < 2) continue;
    if (typeof host !== 'string' || host === '') continue;
    if (typeof path !== 'string' || !path.startsWith('/')) continue;
    if (site !== 'community' && site !== 'store') continue;
    // No cast: the guard above narrowed `site` to 'community' | 'store', i.e. SteamSite itself.
    out.push({ ruleId, host, path, site });
  }
  return out.length > 0 ? out : undefined;
}

function buildWeb(raw: Record<string, unknown>, _ctx: Ctx): WebSettings {
  const web = defaultWeb();
  const anchor = nonEmptyStr(raw.bannerAnchorSelector, _ctx) as string | undefined;
  const logout = callExpression(raw.logoutExpression, _ctx) as string | undefined;
  const tradeUrl = httpUrl(raw.tradeOffersUrl, _ctx) as string | undefined;
  const loginUrl = httpUrl(raw.steamLoginUrl, _ctx) as string | undefined;
  const activeLink = httpUrl(raw.activeBannerLink, _ctx) as string | undefined;
  const dmUrl = httpUrl(raw.dmarketUrl, _ctx) as string | undefined;
  const antiCsrf = validAntiCsrf(raw.antiCsrf);
  const reconnect = int(0)(raw.reconnectDebounceMs, _ctx) as number | undefined;
  const refresh = int(0)(raw.refreshDebounceMs, _ctx) as number | undefined;
  // Floored at 1s: a smaller value would abort every proof before it could start, which is worse than no
  // timeout at all — it would turn a reachable notary into a permanent failure via a remote publish.
  const proofTimeout = int(1000)(raw.notaryProofTimeoutMs, _ctx) as number | undefined;
  // `0` is a deliberate kill switch (watch off), so the validator floor is 0 — but any other value is raised
  // to NOTARY_STUCK_FLOOR_MS, because a threshold under the probe interval declares every proof wedged.
  const stuckAfter = int(0)(raw.notaryStuckAfterMs, _ctx) as number | undefined;
  // `0` means "never recycle", so the validator floor is 0 and no clamp follows: unlike the silence threshold,
  // every value here is serviceable — 1 is the old per-proof behaviour, and a large one is a long-lived realm.
  const proofsPerInstance = int(0)(raw.notaryProofsPerInstance, _ctx) as number | undefined;
  const origins = Array.isArray(raw.bridgeExtraOrigins)
    ? raw.bridgeExtraOrigins
        .map((o) => (httpUrl(o, _ctx) ? new URL(o as string).origin : undefined))
        .filter((o): o is string => typeof o === 'string')
    : undefined;

  if (anchor !== undefined) web.bannerAnchorSelector = anchor;
  if (logout !== undefined) web.logoutExpression = logout;
  if (tradeUrl !== undefined) web.tradeOffersUrl = tradeUrl;
  if (loginUrl !== undefined) web.steamLoginUrl = loginUrl;
  if (activeLink !== undefined) web.activeBannerLink = activeLink;
  if (dmUrl !== undefined) web.dmarketUrl = dmUrl;
  if (antiCsrf !== undefined) web.antiCsrf = antiCsrf;
  if (reconnect !== undefined) web.reconnectDebounceMs = reconnect;
  if (refresh !== undefined) web.refreshDebounceMs = refresh;
  if (proofTimeout !== undefined) web.notaryProofTimeoutMs = proofTimeout;
  if (stuckAfter !== undefined) {
    web.notaryStuckAfterMs = stuckAfter === 0 ? 0 : Math.max(stuckAfter, NOTARY_STUCK_FLOOR_MS);
  }
  if (proofsPerInstance !== undefined) web.notaryProofsPerInstance = proofsPerInstance;
  if (origins !== undefined) web.bridgeExtraOrigins = origins;
  web.errorReporting = buildErrorReporting(isObj(raw.errorReporting) ? raw.errorReporting : {});
  return web;
}

/**
 * Crash-reporter overrides, clamped so remote config can only ever **narrow** collection. That is enforced
 * by construction rather than by convention: the caps take `Math.min` against the compiled default and the
 * cooldown takes `Math.max`, so a hostile or mistaken publish cannot raise volume or shorten the cooldown —
 * which is what would turn a single redaction miss into a mass leak. The remote-config document is
 * delivered verbatim to every client over an unauthenticated public REST call (src/infra/remoteConfig.ts),
 * so "narrowing only" is the property that matters, not the range of any single field.
 *
 * The endpoint itself is deliberately NOT remote-configurable: one publish would redirect every user's
 * stack traces to an arbitrary host. It is compile-time only (src/infra/config.ts).
 */
function buildErrorReporting(raw: Record<string, unknown>): ErrorReportingSettings {
  const d = ERROR_REPORTING_DEFAULTS;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : d.enabled;
  const maxPerDay = intOrNull(raw.maxPerDay);
  const maxPerDayFromPage = intOrNull(raw.maxPerDayFromPage);
  const fpCooldownMs = intOrNull(raw.fpCooldownMs);
  return {
    // `false` always wins: a kill switch must work, an "enable" must not resurrect a disabled reporter.
    enabled: enabled && d.enabled,
    maxPerDay: maxPerDay === null ? d.maxPerDay : Math.min(d.maxPerDay, maxPerDay),
    maxPerDayFromPage:
      maxPerDayFromPage === null ? d.maxPerDayFromPage : Math.min(d.maxPerDayFromPage, maxPerDayFromPage),
    fpCooldownMs: fpCooldownMs === null ? d.fpCooldownMs : Math.max(d.fpCooldownMs, fpCooldownMs),
    // MERGED with the compiled list, never replacing it, and substrings only — a remote-supplied regex run
    // over attacker-influenceable error text is a ReDoS in the service worker.
    suppressSubstrings: Array.isArray(raw.suppressSubstrings)
      ? raw.suppressSubstrings
          .filter((v): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 120)
          .slice(0, 32)
      : [],
  };
}

/** A non-negative integer, or null to mean "not specified". */
function intOrNull(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.floor(v);
  return n < 0 ? null : n;
}

function hostPermissionOrigins(): Set<string> {
  const out = new Set<string>();
  try {
    const hp = (browser.runtime.getManifest().host_permissions ?? []) as string[];
    for (const pattern of hp) {
      try {
        out.add(new URL(pattern.replace(/\*+$/, '')).origin);
      } catch {
        /* skip non-URL patterns */
      }
    }
  } catch {
    /* no manifest (e.g. a plain Node test harness) → host/base-URL overrides are rejected */
  }
  return out;
}

/** Parse + validate the Remote Config entries into typed Settings. Pure; never throws. */
export function parseSettings(entries: ConfigEntries): Settings {
  const raw = entries[REMOTE_CONFIG_PARAM];
  let doc: unknown = {};
  if (typeof raw === 'string' && raw.trim() !== '') {
    try {
      doc = JSON.parse(raw);
    } catch {
      doc = {};
    }
  }
  const root = isObj(doc) ? doc : {};
  const ctx: Ctx = { origins: hostPermissionOrigins() };
  return {
    tracker: buildTracker(isObj(root.tracker) ? root.tracker : {}, ctx),
    web: buildWeb(isObj(root.web) ? root.web : {}, ctx),
  };
}

// ---- Snapshot + reactive access -------------------------------------------------------------------

let snapshot: Settings = DEFAULTS;

/** The current settings snapshot (compiled defaults until the first {@link loadSettings}). Synchronous. */
export function getSettings(): Settings {
  return snapshot;
}

/**
 * The DMarket session cookie name the core reads — the remote override when present, else the compiled
 * mirror of the core default. The extension watches this cookie by name to nudge re-evaluation
 * (src/background/refresh.ts), so it must always agree with the running core's config.
 */
export function getMarketplaceCookieName(): string {
  return snapshot.tracker.marketplaceScrape?.cookieName ?? MARKETPLACE_COOKIE_NAME;
}

/**
 * The Steam session cookie name the core reads — the remote override when present, else the compiled
 * mirror of the core default. The extension watches this cookie by name to nudge re-evaluation
 * (src/background/refresh.ts), so it must always agree with the running core's config.
 */
export function getSteamSessionCookieName(): string {
  return snapshot.tracker.steamScrape?.steamSessionCookieName ?? STEAM_SESSION_COOKIE_NAME;
}

/** Read the Remote Config cache once, refresh the snapshot, and return it. Never throws. */
export async function loadSettings(): Promise<Settings> {
  try {
    snapshot = parseSettings(await readCachedEntries());
  } catch {
    snapshot = DEFAULTS;
  }
  return snapshot;
}

/**
 * Keep the snapshot live: re-load whenever the Remote Config cache changes. Returns an unsubscribe.
 * `onChange` (optional) fires with the fresh snapshot after each reload — the service worker uses it to
 * restart the core / re-install anti-CSRF when the effective config changes.
 */
export function subscribeSettings(onChange?: (s: Settings) => void): () => void {
  return onStorageChanged((changes, area) => {
    if (area !== 'local' || !(REMOTE_CONFIG_CACHE_KEY in changes)) return;
    void loadSettings().then((s) => onChange?.(s));
  });
}

/** Convenience: load the snapshot now and keep it live. Returns an unsubscribe. */
export function initSettings(onChange?: (s: Settings) => void): () => void {
  void loadSettings().then((s) => onChange?.(s));
  return subscribeSettings(onChange);
}
