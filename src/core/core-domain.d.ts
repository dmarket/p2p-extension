// Ambient types for the installed package's DOMAIN module. The config classes are declared in the core's
// `.d.mts` but are NOT re-exported from the package main at runtime — they only live in the domain
// module (which ships no type definitions). The seam (src/core/tracker.ts) imports them via the
// `@dmarket/p2p-tracker-core-domain` Vite alias (see wxt.config.ts) to build a TrackerConfig from the
// remote-config overlay (src/config/settings.ts).
//
// These signatures mirror node_modules/@dmarket/p2p-tracker-core/p2p-tracker-core.d.mts verbatim (the
// runtime domain .mjs exports the same classes). `copy(...)` mirrors the generated data-class copy:
// every arg is optional and, when omitted, keeps the receiver's current value — so a partial override
// is `base.copy(undefined, newValue, …)`.
//
// THESE SIGNATURES ARE HAND-WRITTEN, AND THE ALIAS MEANS `tsc` CANNOT CHECK THEM AGAINST THE REAL
// MODULE. A stale parameter here does not fail to compile — it silently shifts every later positional
// `copy()` argument onto the wrong field, which is exactly what a phantom `backoff` slot did (a
// `MarketplaceScrapeConfig` landed in `notary`, and the notary could not be enabled at all). Keep them in
// step with `node_modules/@dmarket/p2p-tracker-core/p2p-tracker-core.d.mts`; `npm run compile` runs
// scripts/check-core-params.mjs, which diffs the orders in src/config/coreParams.ts against that file.
//
// The one sanctioned divergence is a TRAILING parameter the core already declares but its npm publish has not
// carried yet. Those are listed in `PENDING` in scripts/check-core-params.mjs, which is also what forces them
// to be reconciled: it fails the build as soon as the installed file grows the parameter. Nothing in the
// MIDDLE may run ahead — see below.
//
// Trailing parameters the extension never sets are simply omitted (a positional call stops at the last
// argument supplied) — `TrackerConfig`'s `writeClaims`/`steamWrites` and `NotaryConfig`'s two
// `KtList<string>` reveal-path fields are all trailing, so their absence is safe. A parameter in the
// MIDDLE is not: it must be declared even if unused, or everything after it moves.

declare module '@dmarket/p2p-tracker-core-domain' {
  export class CadenceConfig {
    copy(
      activeOfferIntervalMs?: number,
      revertWatchIntervalMs?: number,
      maxActionDelayMs?: number,
      webPollFloorMs?: number,
      iosForegroundPollFloorMs?: number,
      iosBackgroundPollFloorMs?: number,
      androidForegroundPollFloorMs?: number,
      androidBackgroundPollFloorMs?: number,
      webHeartbeatFloorMs?: number,
      iosForegroundHeartbeatFloorMs?: number,
      iosBackgroundHeartbeatFloorMs?: number,
      androidForegroundHeartbeatFloorMs?: number,
      androidBackgroundHeartbeatFloorMs?: number,
      expeditedOfferIntervalMs?: number,
      expeditedWindowMs?: number,
      fallbackHeartbeatIntervalMs?: number,
    ): CadenceConfig;
  }

  export class CredentialConfig {
    copy(
      steamSkewMs?: number,
      marketplaceSkewMs?: number,
      sessionGateHeadroomMs?: number,
      marketplaceSessionGateHeadroomMs?: number,
      marketplaceRefreshMinLifeMs?: number,
      marketplaceRefreshMinIntervalMs?: number,
    ): CredentialConfig;
  }

  export class HttpConfig {
    copy(requestTimeoutMs?: number): HttpConfig;
  }

  export class MarketplaceRetryConfig {
    copy(maxRetries?: number, retryBaseDelayMs?: number, retryMaxDelayMs?: number): MarketplaceRetryConfig;
  }

  export class MarketplaceScrapeConfig {
    readonly cookieName: string;
    readonly refreshUrl: string;
    readonly refreshCookieName: string;
    readonly tokenRefreshPath: string;
    readonly tokenRefreshUrl: string | null;
    readonly deferRefreshWhileSiteTabOpen: boolean;
    copy(
      cookieName?: string,
      refreshUrl?: string,
      refreshCookieName?: string,
      tokenRefreshPath?: string,
      tokenRefreshUrl?: string | null,
      deferRefreshWhileSiteTabOpen?: boolean,
    ): MarketplaceScrapeConfig;
  }

  export class NotaryConfig {
    /**
     * The core's own default for {@link copy}'s `notaryUrl` slot — the deployed production notary.
     *
     * Declared so the extension's copy of that string can be pinned to it by a test instead of by a
     * comment (src/config/notaryUrl.test.ts): the two have to agree, and the build-time check in
     * scripts/verify-build.mjs cannot tell them apart once both are in the bundle.
     *
     * Kotlin/JS exports the companion of an exported class as a static `Companion` singleton. Verified
     * at runtime through this very alias before being declared here — the shape is codegen, not contract.
     */
    static readonly Companion: { readonly PRODUCTION_NOTARY_URL: string };

    // `offerRead` / `historyRead` are NO LONGER trailing, so they can no longer be omitted: `rootStorePem`
    // sits behind them. They are Kotlin data classes and not constructible from JS, so they are declared as
    // `never` — present for POSITION, impossible to pass. Each groups a host, a path template and the reveal
    // paths for one proven read: one package that ships with the code, never remotely.
    //
    // The signature now runs to slot 18. Slots 13 and 17 are the two online-decryption budgets
    // (`maxRecvDataOnline`, `maxRecvRecordsOnline`); everything between them is `never` for the same POSITION
    // reason, which here does double duty: this file is HAND-WRITTEN, so `never` on a slot nothing may set is
    // the strongest available statement that a future edit adding a settable type has to justify itself. Kept
    // in step with the core by scripts/check-core-params.mjs — `tsc` compares against this file, not the
    // package.
    //
    // The signature runs to slot 18. It mirrors the installed `.d.mts` exactly — `sentBudgetMarginPercent`
    // was declared ahead of its publish for a while, registered in `PENDING` in
    // scripts/check-core-params.mjs, and that entry retired itself at `.186`.
    copy(
      maxConcurrency?: number,
      // Non-nullable, matching the installed `.d.mts` since `.194`: the core defaults this to the
      // production notary, so an unset has nothing to express and the prover's gate is the proof delegate.
      // Omitting the slot still means "keep the core's value", which is how that default is taken.
      notaryUrl?: string,
      proxyBaseUrl?: string,
      subprotocol?: string,
      maxSentData?: number,
      maxRecvData?: number,
      threadCount?: number,
      provenCookieHeader?: string,
      offerRead?: never,
      historyRead?: never,
      rootStorePem?: string | null,
      acceptedProofTtlMs?: never,
      breaker?: never,
      maxRecvDataOnline?: number,
      reads?: never,
      acknowledgeCommunityResponseDisclosure?: never,
      onlineBudgetMarginPercent?: never,
      maxRecvRecordsOnline?: number,
      sentBudgetMarginPercent?: number,
    ): NotaryConfig;
  }

  export class SteamEndpointsConfig {
    copy(
      steamApiBaseUrl?: string,
      getTradeOfferPath?: string,
      getTradeOffersPath?: string,
      getTradeHistoryPath?: string,
      getPlayerSummariesPath?: string,
      getSteamLevelPath?: string,
      loginBaseUrl?: string,
      communityBaseUrl?: string,
      storeBaseUrl?: string,
      historyMaxTrades?: number,
      bulkOfferThreshold?: number,
      paramAccessToken?: string,
      paramTradeOfferId?: string,
      paramGetSentOffers?: string,
      paramActiveOnly?: string,
      paramGetDescriptions?: string,
      paramMaxTrades?: string,
      paramSteamIds?: string,
      paramSteamId?: string,
      // Positions 20-25 are core-only tunables the remote-config overlay does not expose (own-inventory
      // paging, the notification read). They are declared because `copy()` is POSITIONAL: reaching
      // `paramGetReceivedOffers` means passing them, and a signature that stopped at `paramSteamId`
      // would put the new value on `inventoryPageCount`.
      inventoryPageCount?: number,
      inventoryMaxPages?: number,
      getSteamNotificationsPath?: string,
      paramIncludeRead?: string,
      paramIncludeHidden?: string,
      paramLanguage?: string,
      paramGetReceivedOffers?: string,
    ): SteamEndpointsConfig;
  }

  export class SteamProfileConfig {
    copy(
      cacheTtlMs?: number,
      maxConcurrency?: number,
      batchSize?: number,
      requestTimeoutMs?: number,
      maxRetries?: number,
      retryBaseDelayMs?: number,
      retryMaxDelayMs?: number,
    ): SteamProfileConfig;
  }

  export class SteamScrapeConfig {
    copy(
      tokenRegex?: string,
      steamIdRegex?: string,
      steamSessionCookieName?: string,
      steamSessionIdCookieName?: string,
    ): SteamScrapeConfig;
  }

  export class GameConfig {
    copy(cs2InventoryContextId?: number): GameConfig;
  }

  export class TrackerConfig {
    constructor();
    readonly cadence: CadenceConfig;
    readonly credentials: CredentialConfig;
    readonly http: HttpConfig;
    readonly marketplaceRetry: MarketplaceRetryConfig;
    readonly marketplaceScrape: MarketplaceScrapeConfig;
    readonly notary: NotaryConfig;
    readonly steamEndpoints: SteamEndpointsConfig;
    readonly steamProfile: SteamProfileConfig;
    readonly steamScrape: SteamScrapeConfig;
    readonly game: GameConfig;
    copy(
      cadence?: CadenceConfig,
      credentials?: CredentialConfig,
      http?: HttpConfig,
      marketplaceRetry?: MarketplaceRetryConfig,
      marketplaceScrape?: MarketplaceScrapeConfig,
      notary?: NotaryConfig,
      steamEndpoints?: SteamEndpointsConfig,
      steamProfile?: SteamProfileConfig,
      steamScrape?: SteamScrapeConfig,
      game?: GameConfig,
    ): TrackerConfig;
  }
}
