// The core config groups' PARAMETER ORDER — the single source of truth for both consumers of it.
//
// Every core config class is a Kotlin data class, and the `copy()` it exports to JS is **positional** —
// JS has no named arguments, so a field is chosen by index and `undefined` in a slot means "keep the
// receiver's value". Each group therefore states its parameter order once, as data, and
// src/core/tracker.ts maps a validated override object onto it.
//
// The lists live HERE, not next to the `copy()` calls, because src/config/settings.ts needs the same
// names to build its validation schemas, and it must not import the seam (that would pull the ~1.2 MB
// core into every context that reads settings). With one copy, a key present in the order but missing
// from a schema is now a compile error (`satisfies Record<…>` in settings.ts) instead of an override
// that validates, gets dropped, and looks applied.
//
// This module is CORE-FREE: the only imports are erasable `import type`s. Adding a core parameter is
// appending a key — the core keeps these lists append-only for exactly that reason, so no existing
// index ever moves.
//
// A key may be appended BEFORE the core's npm publish carries it, so that a two-repo change can be written
// and reviewed as one. Such a key must be declared in `PENDING` in scripts/check-core-params.mjs, which
// permits it by name at the END of an order and then fails the build once the installed package declares
// it — see that block for why the allowance is shaped that narrowly.

import type {
  CadenceOverrides,
  CredentialOverrides,
  NotaryOverrides,
  SteamEndpointsOverrides,
  SteamProfileOverrides,
  SteamScrapeOverrides,
  TrackerOverrides,
} from '@/config/settings';

/** Core parameters the remote-config overlay deliberately does not expose; their slots only hold place. */
export type CoreOnlyEndpointParam =
  | 'inventoryPageCount'
  | 'inventoryMaxPages'
  | 'getSteamNotificationsPath'
  | 'paramIncludeRead'
  | 'paramIncludeHidden'
  | 'paramLanguage';

/**
 * The same for `NotaryConfig` — and the single home for WHY each of these is not a knob. They are named in
 * NOTARY_ORDER for POSITION only (see the mechanical argument there), are absent from `NotaryOverrides`, and
 * therefore have no NOTARY_SCHEMA entry to consult: `pickGroup` iterates the schema, so a published value is
 * never looked at. Being off the type is the stronger statement of the two — a settable-looking field that
 * the schema silently drops is exactly the shape this group keeps getting burned by.
 *
 * `rootStorePem` is NOT here despite also being unpublishable: the extension itself sets it, from a dev-only
 * build-time variable. It stays on the type with a `rejectAlways` validator, which is what closes the remote
 * channel while leaving the local one open.
 *
 * - **`proxyBaseUrl`** — the WebSocket-to-TCP proxy the prover reaches the TARGET through. Deployed
 *   infrastructure that ships with the code, like the read definitions, and a wrong value fails every proof
 *   at a step no earlier signal reaches. It earned this the hard way: a stale published document had it set
 *   to the NOTARY's own URL, aiming the target dial at a service that does not proxy TCP to Steam. It
 *   survived the 2026-08-20 pruning of that same document's `notary` group because it was still publishable,
 *   then hid for two weeks — the read's socket is dialled lazily, on the prover's first write, so nothing
 *   touches the proxy until MPC pre-processing succeeds, and while a notary problem kept it from succeeding
 *   the misconfiguration could not produce a symptom. `notaryUrl` stays publishable on purpose: redirecting
 *   the notary is a real operational need, it is reached FIRST so a wrong one fails loudly on the handshake,
 *   and the extension carries its own default for it. None of that holds here.
 * - **`offerRead` / `historyRead`** — which Steam read a proof attests. Unconstructible from JS anyway
 *   (Kotlin data classes), and a settable one would let a publish redirect what gets proven.
 * - **`acceptedProofTtlMs`** — how long an accepted proof suppresses a re-proof; a published value could
 *   suppress one indefinitely.
 * - **`breaker` / `reads`** — Kotlin data classes, unsettable even if we wanted them.
 * - **`acknowledgeCommunityResponseDisclosure`** — a DISCLOSURE decision, not a tuning knob: it gates
 *   proving a `steamcommunity.com` response whose header set is unmeasured and may carry `set-cookie`, so a
 *   remote value able to flip it would publish those headers by config change. Forcing someone to look is
 *   the whole point of the flag.
 * - **`onlineBudgetMarginPercent`** — the deliberate near-miss. The core's own KDoc argues it should move
 *   with `maxRecvDataOnline` ("an operator who raises the floor can also widen the headroom without a
 *   release"), which is a fair reading; it is refused only because opening it was not part of the ask, and
 *   unlike `sentBudgetMarginPercent` no failure mode makes reaching it urgent. To open it: drop the name
 *   from this union, add `onlineBudgetMarginPercent?: number` to `NotaryOverrides` and `int(0)` to
 *   NOTARY_SCHEMA.
 */
export type CoreOnlyNotaryParam =
  | 'proxyBaseUrl'
  | 'offerRead'
  | 'historyRead'
  | 'acceptedProofTtlMs'
  | 'breaker'
  | 'reads'
  | 'acknowledgeCommunityResponseDisclosure'
  | 'onlineBudgetMarginPercent';

/** `refreshUrl` is the extension's own FE origin (env / debug console), never a remote-config key —
 *  which is why the validation schema for this group is deliberately not pinned to the order below. */
type MarketplaceScrapeParam =
  | 'cookieName'
  | 'refreshUrl'
  | 'refreshCookieName'
  | 'tokenRefreshPath'
  | 'tokenRefreshUrl'
  | 'deferRefreshWhileSiteTabOpen';

export const CADENCE_ORDER = [
  'activeOfferIntervalMs',
  'revertWatchIntervalMs',
  'maxActionDelayMs',
  'webPollFloorMs',
  'iosForegroundPollFloorMs',
  'iosBackgroundPollFloorMs',
  'androidForegroundPollFloorMs',
  'androidBackgroundPollFloorMs',
  'webHeartbeatFloorMs',
  'iosForegroundHeartbeatFloorMs',
  'iosBackgroundHeartbeatFloorMs',
  'androidForegroundHeartbeatFloorMs',
  'androidBackgroundHeartbeatFloorMs',
  'expeditedOfferIntervalMs',
  'expeditedWindowMs',
  'fallbackHeartbeatIntervalMs',
] as const satisfies readonly (keyof CadenceOverrides)[];

export const CREDENTIAL_ORDER = [
  'steamSkewMs',
  'marketplaceSkewMs',
  'sessionGateHeadroomMs',
  'marketplaceSessionGateHeadroomMs',
  'marketplaceRefreshMinLifeMs',
  'marketplaceRefreshMinIntervalMs',
] as const satisfies readonly (keyof CredentialOverrides)[];

export const HTTP_ORDER = ['requestTimeoutMs'] as const;

export const MARKETPLACE_RETRY_ORDER = ['maxRetries', 'retryBaseDelayMs', 'retryMaxDelayMs'] as const;

export const MARKETPLACE_SCRAPE_ORDER = [
  'cookieName',
  'refreshUrl',
  'refreshCookieName',
  'tokenRefreshPath',
  'tokenRefreshUrl',
  'deferRefreshWhileSiteTabOpen',
] as const satisfies readonly MarketplaceScrapeParam[];

/** `signatureAlg` and `teardownEveryNProofs` were removed from the core (the prover takes its signature
 *  algorithm from `IssuanceConfig`'s own defaults, and there is no teardown knob) — their slots are gone
 *  too, since both sat mid-list and shifted everything from `maxSentData` onward. `enabled` went the same
 *  way, from slot 0: it was redundant with the backend's per-deal `proof_required`. `notaryUrl` was then the
 *  only switch, and since core `.194` it is not a switch at all — it defaults to the production notary, and
 *  the prover is gated on the host's proof delegate.
 *
 *  The list used to stop at `provenCookieHeader`, because `check-core-params.mjs` prefix-matches and the two
 *  slots after it — `offerRead` / `historyRead`, each a `ProvenRead` grouping the host, the path template and
 *  the reveal paths — cannot be expressed as a plain override: they are Kotlin data classes, and the read
 *  they define is one package that ships with the code (a stale published half is exactly how
 *  `/tradeoffer/{offerId}/` once survived the retarget to the Steam API and failed every proof). It now runs
 *  past them to reach `rootStorePem`; see the comment at those entries for why that is unavoidable.
 *
 *  It now runs further still — to slot 17 — for the ONLINE-DECRYPTION BUDGET, and the same trade applies at
 *  five more slots. `maxRecvDataOnline` (13) is the knob currently being walked through values against live
 *  proofs, and `maxRecvRecordsOnline` (17) is its record-count sibling with no known value at all. Both were
 *  unreachable from here while the list stopped at 10, which meant tuning either one took a core release —
 *  for a pair of numbers whose entire purpose is to be measured. Everything between them is named for
 *  position and refused in NOTARY_SCHEMA.
 *
 *  Slot 18 (`sentBudgetMarginPercent`) runs it one further, and is the first entry in this file the INSTALLED
 *  package does not declare yet — the core has it, the npm publish carrying it has not happened. It is named
 *  in `PENDING` in scripts/check-core-params.mjs, which is what keeps `npm run compile` green in the meantime
 *  and what will FAIL the build, asking for that entry back, the moment the published `.d.mts` catches up. */
export const NOTARY_ORDER = [
  'maxConcurrency',
  'notaryUrl',
  'proxyBaseUrl',
  'subprotocol',
  'maxSentData',
  'maxRecvData',
  'threadCount',
  'provenCookieHeader',
  // POSITION ONLY, and this is not a style choice. `withOverrides` maps this array onto the core's positional
  // constructor by INDEX, and `@JsExport.Ignore` does NOT remove a parameter from that constructor — verified
  // in the published `.d.mts`, where `offerRead` and `historyRead` are declared args 8 and 9. So reaching
  // `rootStorePem` at slot 10 means naming the two ahead of it. Appending `rootStorePem` alone would put a PEM
  // where the core reads `offerRead`: the description of WHICH Steam read to prove. Types match, nothing
  // throws, and the proof dies `UnknownIssuer` with a corrupted read on top. (Found by dmarket/harnesses#50.)
  //
  // The same mechanical argument covers every name below that carries no SETTABLE note: they hold a slot so a
  // later one can be addressed, and each is listed in `CoreOnlyNotaryParam` — which is where the per-field
  // reasoning lives, so that this list stays about position and that union stays about policy.
  //
  // `rootStorePem` at slot 10 is the exception worth knowing: it IS on `NotaryOverrides`, because the
  // extension sets it from a dev-only build-time variable. Only the REMOTE channel is closed, by a
  // `rejectAlways` validator in NOTARY_SCHEMA.
  'offerRead',
  'historyRead',
  'rootStorePem',
  'acceptedProofTtlMs',
  'breaker',
  // Slot 13 — SETTABLE. Response bytes preprocessed for online decryption; the rest of the body is decrypted
  // deferred. Walked through 32 / 1024 / 2048 / 4096 against live proofs, each value a measurement, and each
  // measurement previously cost a core release to run.
  'maxRecvDataOnline',
  'reads',
  'acknowledgeCommunityResponseDisclosure',
  'onlineBudgetMarginPercent',
  // Slot 17 — SETTABLE. The record-count half of the same budget, new on the vendored prover. Its default is
  // whatever the artifact's own contract says — upstream documents no figure — so an absent override is NOT
  // "0", it is "keep the prover's default", which is what the core sends when this is unset.
  'maxRecvRecordsOnline',
  // Slot 18 — SETTABLE, and PENDING the core's npm publish (see the block comment above, and `PENDING` in
  // scripts/check-core-params.mjs). Headroom in percent over a *computed* send-transcript requirement: the
  // core's `ProvenSentBudget` sizes `maxSentData` down to the request it can derive — 103 B of HTTP framing
  // plus the read's own path plus the token — times this margin, clamped at the configured `maxSentData`, for
  // any token-authed read with no headers, no body and no per-read override. On the history axis that is the
  // `196 + len(steamAccessToken)` its KDoc measured: the observed 522-char token needs 718 B and 15% admits
  // 826 against a flat 1024, ~2 MB less MPC pre-processing per proof on a ~41 MB session.
  //
  // Opened for the ROLLBACK, not for tuning, and that distinction is the whole justification: exceeding the
  // send budget fails EVERY proof, not some of them, so the sizing needs an off switch that does not wait for
  // a release. Publishing anything >= 44 makes the computed budget clamp back at `maxSentData` and restores
  // the previous behaviour exactly — one value, one publish. `onlineBudgetMarginPercent` three slots up is the
  // counter-example: same shape of knob, refused, because no failure mode makes reaching it urgent.
  'sentBudgetMarginPercent',
] as const satisfies readonly (keyof NotaryOverrides | CoreOnlyNotaryParam)[];

export const STEAM_ENDPOINTS_ORDER = [
  'steamApiBaseUrl',
  'getTradeOfferPath',
  'getTradeOffersPath',
  'getTradeHistoryPath',
  'getPlayerSummariesPath',
  'getSteamLevelPath',
  'loginBaseUrl',
  'communityBaseUrl',
  'storeBaseUrl',
  'historyMaxTrades',
  'bulkOfferThreshold',
  'paramAccessToken',
  'paramTradeOfferId',
  'paramGetSentOffers',
  'paramActiveOnly',
  'paramGetDescriptions',
  'paramMaxTrades',
  'paramSteamIds',
  'paramSteamId',
  // Slots 20-25: core-only, named for documentation. An overrides object never carries these keys, so
  // they read as "keep the core default" — they are listed because the parameter after them is exposed.
  'inventoryPageCount',
  'inventoryMaxPages',
  'getSteamNotificationsPath',
  'paramIncludeRead',
  'paramIncludeHidden',
  'paramLanguage',
  'paramGetReceivedOffers',
] as const satisfies readonly (keyof SteamEndpointsOverrides | CoreOnlyEndpointParam)[];

export const STEAM_PROFILE_ORDER = [
  'cacheTtlMs',
  'maxConcurrency',
  'batchSize',
  'requestTimeoutMs',
  'maxRetries',
  'retryBaseDelayMs',
  'retryMaxDelayMs',
] as const satisfies readonly (keyof SteamProfileOverrides)[];

export const STEAM_SCRAPE_ORDER = [
  'tokenRegex',
  'steamIdRegex',
  'steamSessionCookieName',
  'steamSessionIdCookieName',
] as const satisfies readonly (keyof SteamScrapeOverrides)[];

export const GAME_ORDER = ['cs2InventoryContextId'] as const;

/** The core's trailing `writeClaims` / `steamWrites` groups are not exposed here. Being trailing, they can
 *  be omitted outright — a positional call stops at the last argument supplied. `backoff` used to sit at
 *  index 1 and was dropped from the core; leaving its slot in place silently shifted every later group by
 *  one, putting `MarketplaceScrapeConfig` into `notary` (so the notary could never be enabled) and the FE
 *  origin nowhere. Removing a MIDDLE parameter is never safe — see CoreOnlyEndpointParam for how those are
 *  held open instead. */
export const TRACKER_ORDER = [
  'cadence',
  'credentials',
  'http',
  'marketplaceRetry',
  'marketplaceScrape',
  'notary',
  'steamEndpoints',
  'steamProfile',
  'steamScrape',
  'game',
] as const satisfies readonly (keyof TrackerOverrides)[];
