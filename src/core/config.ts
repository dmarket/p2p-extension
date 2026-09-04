// Building a core `TrackerConfig` from validated remote-config overrides.
//
// Split out of src/core/tracker.ts because there are now TWO contexts that need it: the service worker,
// which configures the tracker loop, and the offscreen document, which configures the TLSN prover (see
// src/entrypoints/offscreen/main.ts). Those two must never disagree — a prover running on different
// values than the loop that dispatched to it is the failure this module exists to make impossible — and
// the only way to guarantee that is one implementation of the positional `copy()` contract.
//
// Deliberately imports the DOMAIN module only, not the core: the offscreen document has no business
// pulling in the tracker loop, and src/core/tracker.ts imports both anyway.

// Config classes are not re-exported from the package main — imported from the domain module via a
// dedicated alias (see wxt.config.ts + src/core/core-domain.d.ts).
import { TrackerConfig } from '@dmarket/p2p-tracker-core-domain';
// Type-only: the validated remote-config overrides applied onto a fresh TrackerConfig.
import type { TrackerOverrides } from '@/config/settings';
// The positional parameter order of every core config group — shared with the validation schemas in
// src/config/settings.ts so the two can't drift (see that module's header).
import {
  CADENCE_ORDER,
  CREDENTIAL_ORDER,
  GAME_ORDER,
  HTTP_ORDER,
  MARKETPLACE_RETRY_ORDER,
  MARKETPLACE_SCRAPE_ORDER,
  NOTARY_ORDER,
  STEAM_ENDPOINTS_ORDER,
  STEAM_PROFILE_ORDER,
  STEAM_SCRAPE_ORDER,
  TRACKER_ORDER,
} from '@/config/coreParams';

// ---- Applying overrides onto the core's config classes ---------------------------------------------
//
// The positional `copy()` contract and the per-group parameter order live in @/config/coreParams (see
// its header for why). This module only maps a validated override object onto that order: spelling the
// calls out argument-by-argument put the contract at the call site, where a key in the wrong place
// silently wrote an override onto the neighbouring field with nothing failing.

/** Any core config class: each exports a positional, all-optional `copy()` returning its own type. */
type CopyableConfig<T> = T & { copy: (...args: never[]) => T };

/**
 * Applies [overrides] onto [base] through its positional `copy()`, mapping each value by its slot in
 * [order]. Returns `undefined` when there is nothing to apply, so an absent group stays absent instead
 * of becoming a copy that merely equals the default.
 *
 * Trailing `undefined`s are dropped, so overriding one early field still passes one argument — the
 * placeholders that reach a late parameter exist only at runtime, never in source.
 */
function withOverrides<T, K extends string>(
  base: CopyableConfig<T>,
  order: readonly K[],
  overrides: Partial<Record<K, unknown>> | undefined,
): T | undefined {
  if (overrides === undefined) return undefined;
  const args: unknown[] = order.map((key) => overrides[key]);
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
  if (args.length === 0) return undefined;
  return (base.copy as (...a: unknown[]) => T)(...args);
}

/**
 * Build a TrackerConfig from the FE origin + the validated remote-config overrides, or `undefined` when
 * there is nothing to override (→ the core runs on its own defaults). `feUrl` is the origin BOTH DMarket
 * session cookies are read from and written to (`MarketplaceScrapeConfig.refreshUrl`, default
 * `https://dmarket.com/`); it is owned by the extension's endpoint config (env / debug console), so it
 * always wins over any remote `marketplaceScrape.refreshUrl` (which the overlay never surfaces anyway).
 * Note it is NOT the refresh endpoint — that is derived from the API base plus `tokenRefreshPath`.
 *
 * Overrides are already type/range-validated in src/config/settings.ts, so each group's `copy(...)` only
 * receives values the core accepts (the constructor-validated groups can't throw — including
 * `CredentialConfig`, whose rotation floors are range-gated and one-way-clamped there).
 *
 * Omit `feUrl` when the caller is not the tracker loop: the offscreen prover reads only the `notary` and
 * `game` groups (`proveNotaryTransition`'s KDoc), and passing an FE origin it will never use would
 * misrepresent what crossed the boundary.
 */
export function buildTrackerConfig(feUrl?: string, o: TrackerOverrides = {}): TrackerConfig | undefined {
  const d = new TrackerConfig();

  // `refreshUrl` is the extension's own FE origin, not the overlay's, so it is injected here rather than read
  // from `o`. Everything else in the group passes through as published. No "is anything set?" guard is needed:
  // `withOverrides` already returns `undefined` when every slot is, which is exactly what an absent group
  // should produce — and spelling the fields out here again is how a newly added one gets silently dropped.
  // `tokenRefreshUrl` is deliberately never set: an absolute endpoint override is an env/debug concern, and
  // the core allow-lists its origin regardless.
  const scrapeOverrides = { ...o.marketplaceScrape, refreshUrl: feUrl };

  return withOverrides(d, TRACKER_ORDER, {
    cadence: withOverrides(d.cadence, CADENCE_ORDER, o.cadence),
    credentials: withOverrides(d.credentials, CREDENTIAL_ORDER, o.credentials),
    http: withOverrides(d.http, HTTP_ORDER, o.http),
    marketplaceRetry: withOverrides(d.marketplaceRetry, MARKETPLACE_RETRY_ORDER, o.marketplaceRetry),
    marketplaceScrape: withOverrides(d.marketplaceScrape, MARKETPLACE_SCRAPE_ORDER, scrapeOverrides),
    notary: withOverrides(d.notary, NOTARY_ORDER, o.notary),
    steamEndpoints: withOverrides(d.steamEndpoints, STEAM_ENDPOINTS_ORDER, o.steamEndpoints),
    steamProfile: withOverrides(d.steamProfile, STEAM_PROFILE_ORDER, o.steamProfile),
    steamScrape: withOverrides(d.steamScrape, STEAM_SCRAPE_ORDER, o.steamScrape),
    game: withOverrides(d.game, GAME_ORDER, o.game),
  });
}
