// Route the tracker core's Steam traffic at a local Steam stand-in — NON-PRODUCTION builds only, and
// only when one is configured (`WXT_DEV_STEAM_URL`; see .env.example).
//
// Why it exists: Steam's hosts are hard-coded inside the compiled core — they are Steam's, so there is
// nothing there to configure — which leaves every Steam-coupled flow (autonomous session refresh, trade
// send, cancel) reachable only through the real thing. That needs a live Steam login, it rate-limits, and
// a wrong send is not undoable, so those paths cannot be exercised repeatably. Redirecting them at a
// stand-in is what makes them testable. The obvious alternative — remapping the hosts a layer lower with
// `--host-resolver-rules` — needs a browser started with flags and a throwaway profile, i.e. not the
// browser a developer already has the extension loaded in.
//
// Mechanism: wrap the service worker's global `fetch` and rewrite the URL of Steam requests only. That is
// the entire surface — the core's Ktor JS client funnels all of its HTTP through one bare global
// `fetch(input, init)` — and it is what keeps this working in an ordinary browser window: no launch
// flags, no dedicated profile, and nothing outside this extension is affected.
//
// Deliberately narrow, in three ways:
//   • Steam hosts only. DMarket and everything else go to the original `fetch` untouched — as does any
//     request whose URL does not parse, so a failure here can never lose a request.
//   • `fetch` only. Cookies are NOT redirected: the Steam session cookie is read from the real
//     `steamcommunity.com` origin (src/background/refresh.ts) and a stand-in never gets to set it there,
//     so a build using one needs that cookie put in place by hand before Steam reads as connected.
//     Page navigations and the on-page content script are untouched too — they still talk to real Steam.
//   • `import.meta.env.DEV` is a compile-time constant, so the whole module is dead-code-eliminated from
//     production bundles. There is no production path on which an unset variable is even consulted.
//
// Install synchronously at background top level, BEFORE the core is booted: its boot cycle can reach
// Steam on the first heartbeat, and a wrapper installed after that would miss the call. The dev-only
// network log (src/debug/netLog.ts) wraps `fetch` later, i.e. OUTSIDE this one, so it keeps reporting the
// Steam URL the core asked for rather than the rewritten one — which is what makes a captured log
// comparable to one taken against real Steam.

/** Every Steam host the core talks to — the same set as the production `host_permissions`. */
const STEAM_HOSTS = new Set([
  'steamcommunity.com',
  'www.steamcommunity.com',
  'api.steampowered.com',
  'login.steampowered.com',
  'store.steampowered.com',
]);

let installed = false;

/**
 * Point the core's Steam requests at the origin in `WXT_DEV_STEAM_URL`.
 *
 * A no-op in production builds, and in non-production builds with the variable unset — which is the
 * default, so an ordinary debug build still talks to real Steam. Idempotent; call synchronously at
 * background top level, before the core is booted.
 */
export function installDevSteamRedirect(): void {
  if (!import.meta.env.DEV) return;
  const configured = import.meta.env.WXT_DEV_STEAM_URL?.trim();
  if (!configured || installed) return;

  let origin: string;
  try {
    origin = new URL(configured).origin;
  } catch {
    // Loud but non-fatal: a typo'd stand-in must not take the extension down, and falling through to
    // real Steam silently is exactly the failure that looks like a broken stand-in for an afternoon.
    console.warn(`[dmarket-p2p] WXT_DEV_STEAM_URL is not a URL (${configured}) — Steam not redirected`);
    return;
  }
  installed = true;

  const origFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const redirected = steamRedirect(input, origin);
    return redirected === undefined ? origFetch(input, init) : origFetch(redirected, init);
  };

  console.info(`[dmarket-p2p] Steam requests redirected to ${origin}`);
}

/**
 * What to fetch instead, or `undefined` to leave the request alone (not Steam, or unrewritable).
 *
 * The stand-in serves Steam's endpoints on its own origin, so only the origin is swapped; path and query
 * are carried across verbatim. Note that the original HOST is therefore not conveyed — a stand-in that
 * needs to tell `steamcommunity.com` from `api.steampowered.com` has to do it by path, as Steam's own
 * paths do not collide.
 */
function steamRedirect(input: RequestInfo | URL, origin: string): RequestInfo | undefined {
  let raw: string;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (input instanceof Request) raw = input.url;
  else return undefined;

  let url: URL;
  try {
    // Resolved against the worker's own URL so a relative fetch (an extension asset) parses instead of
    // throwing; its origin is `chrome-extension://…`, which never matches below.
    url = new URL(raw, self.location?.href);
  } catch {
    return undefined;
  }
  if (!STEAM_HOSTS.has(url.hostname)) return undefined;

  const target = origin + url.pathname + url.search;
  if (!(input instanceof Request)) return target;
  // A Request's URL is immutable, so it has to be rebuilt — and a rebuild can only carry a body across
  // asynchronously (a stream body needs `duplex: 'half'`, which is not accepted over plain http). So a
  // bodyless Request is rebuilt exactly, and one with a body is left to real Steam rather than sent
  // somewhere with its payload quietly dropped. The core only ever passes a URL string, so neither
  // branch is expected to be reached.
  if (input.body === null) return new Request(target, input);
  console.warn('[dmarket-p2p] Steam Request with a body not redirected — pass a URL string instead');
  return undefined;
}
