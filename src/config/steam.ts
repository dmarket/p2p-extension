// Steam integration config — the single source of truth for every Steam-coupled selector, URL, and
// page-global the extension depends on. These are the things Steam can change out from under us
// (page DOM, anti-CSRF endpoints, the logout entry point), so they live here rather than scattered
// across the code.
//
// Shaped as a plain frozen object so the remote-config layer can overlay it and patch a broken
// selector/URL without a redeploy. That layer is live: src/config/settings.ts pulls these values into
// its `web` defaults and merges the fetched document over them, so consumers read the resolved snapshot
// (`getSettings().web.*`) rather than this object. These are the compiled-in defaults it merges onto.

/** How an anti-CSRF endpoint's Origin/Referer must be rewritten (see src/background/anti-csrf.ts). */
export type SteamSite = 'community' | 'store';

export interface AntiCsrfEndpoint {
  /** DNR session-rule id (Chrome). Ids 2/3/4/5 are used here; id 1 is the core's per-trade send rule. */
  ruleId: number;
  /** Host + path fragment. `*` acts as a wildcard, matching the DNR `urlFilter` / webRequest syntax. */
  host: string;
  path: string;
  /** Which first-party Origin/Referer Steam expects for this endpoint. */
  site: SteamSite;
}

export const STEAM_INTEGRATION = {
  /**
   * The Steam community origin the session cookie is scoped to — the same origin the core reads it from.
   * Used only to address `browser.cookies.get` (see src/background/refresh.ts); the cookie's VALUE is
   * never read here, since its presence alone doesn't prove a live session (the core owns that verdict).
   */
  communityUrl: 'https://steamcommunity.com/',

  /**
   * The user's Steam trade offers page. Steam redirects `/my/...` to the logged-in user's canonical
   * profile URL, so there is no need to resolve a Steam ID. Opened from the popup.
   */
  tradeOffersUrl: 'https://steamcommunity.com/my/tradeoffers',

  /**
   * Where the popup sends a user whose Steam session has ended. Deliberately the login page itself
   * rather than a deep link that merely *redirects* there: this is the page that performs Steam's
   * persistent-login handshake, so a user Steam still remembers is signed back in on arrival — usually
   * without typing anything. `goto` brings them back to the trade-offers page afterwards, which is where
   * the on-page banner lives. Remote-overridable as `web.steamLoginUrl`.
   */
  loginUrl: 'https://steamcommunity.com/login/home/?goto=my%2Ftradeoffers',

  /**
   * The content-script match patterns for the trade-offers page (both canonical forms Steam redirects
   * `/my/tradeoffers` into). REFERENCE ONLY — WXT statically analyses `defineContentScript({ matches })`
   * at build time, so the entrypoint must keep these as inline literals; keep the two in sync.
   */
  tradeOffersMatchPatterns: [
    'https://steamcommunity.com/profiles/*/tradeoffers*',
    'https://steamcommunity.com/id/*/tradeoffers*',
  ],

  /** Selector for Steam's main content area — the on-page banner is anchored as its first child. */
  bannerAnchorSelector: '.maincontent',

  logout: {
    /**
     * The page-global call that signs the user out of Steam. Steam defines a global `Logout()` (it
     * does `PostToURLWithSession('https://steamcommunity.com/login/logout/')`) and its own account
     * menu invokes it via `<a href="javascript:Logout();">`. The mismatch banner mirrors that exactly:
     * it renders an anchor whose href is `javascript:` + this expression, so a real user click runs it
     * natively in the page's main world (no content-script injection). Kept here so a Steam-side rename
     * is a config fix. See src/ui/steam/MismatchBanner.tsx.
     */
    expression: 'Logout();',
  },

  /**
   * Standing Steam anti-CSRF endpoints whose Origin/Referer the extension rewrites so the core's
   * autonomous session refresh / cancel can reach Steam. src/background/anti-csrf.ts builds the DNR
   * `urlFilter` (Chrome) and the webRequest match pattern (Firefox) from each entry. See that file for
   * why the `create` send is deliberately absent (its Referer is per-trade, owned by the core).
   */
  antiCsrf: [
    { ruleId: 4, host: 'steamcommunity.com', path: '/tradeoffer/*/cancel', site: 'community' },
    { ruleId: 2, host: 'steamcommunity.com', path: '/login/settoken', site: 'community' },
    { ruleId: 3, host: 'store.steampowered.com', path: '/login/settoken', site: 'store' },
    { ruleId: 5, host: 'login.steampowered.com', path: '/jwt/ajaxrefresh', site: 'community' },
  ] satisfies AntiCsrfEndpoint[],
} as const;
