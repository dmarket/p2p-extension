// Standing Steam anti-CSRF header rewrites.
//
// Steam's `jwt/ajaxrefresh` (session re-mint request), `login/settoken` (session re-mint) and
// `tradeoffer/{id}/cancel` (cancel) enforce an anti-CSRF check that a background fetch cannot satisfy
// on its own: its Origin is `chrome-extension://…` / `moz-extension://…` and Referer is a forbidden
// fetch header, so Steam rejects the call without a first-party Origin/Referer — `settoken`/`cancel`
// reply 403, and `ajaxrefresh` replies HTTP 200 with `{success:false,error:8}` (InvalidParam), which
// aborts the whole re-mint before settoken is even reached. These calls fire from the core's own alarm
// loop (autonomous session refresh, a leased cancel_offer directive), not from a message handler, so
// the rewrites must be STANDING (installed at boot).
//
// `ajaxrefresh` is issued by the core with `redir=https://steamcommunity.com`, i.e. it mimics a
// re-mint initiated from a community page, so its Origin/Referer are rewritten to `steamcommunity.com`
// (the same first-party the native browser flow would send).
//
// A static Referer is sufficient here: ajaxrefresh/settoken/cancel carry no per-trade `partner`. The
// `create` write (`tradeoffer/new/send`) is deliberately NOT handled here — Steam validates its
// Referer's `partner` against the POST body, so that rewrite must be per-trade. The core installs and
// tears down that rule itself (DNR session-rule id 1) around each send, on every browser. Do not add a
// standing create rewrite here (a static Referer would reintroduce the partner-less-Referer 403).
//
// Per-browser mechanism, selected at build time by `import.meta.env.FIREFOX` — a compile-time
// constant, so only the matching implementation (and its data) is bundled; the other is tree-shaken:
//   • Chrome  → declarativeNetRequest session rules.
//   • Firefox → blocking webRequest.onBeforeSendHeaders. Firefox's DNR support for SETTING the
//     restricted `origin`/`referer` request headers is unreliable, and Firefox uniquely keeps
//     blocking webRequest in MV3 — so it does the same rewrites via webRequest instead.
//
// DNR session-rule ids 2/3/4/5 are used here; id 1 is reserved for the core's per-trade send rule.
//
// The endpoints (ids, hosts, paths, first-party site) are declared in src/config/steam.ts so a
// Steam-side URL change is a config fix, not a code change; this module only maps them onto the
// per-browser mechanism.

import { reportError } from '@/infra/report/reporter';
import type { AntiCsrfEndpoint, SteamSite } from '@/config/steam';
import { getSettings, loadSettings, subscribeSettings } from '@/config/settings';

const SITES: Record<SteamSite, { origin: string; referer: string }> = {
  community: { origin: 'https://steamcommunity.com', referer: 'https://steamcommunity.com/' },
  store: { origin: 'https://store.steampowered.com', referer: 'https://store.steampowered.com/' },
};

/**
 * Install the standing Steam anti-CSRF header rewrites for the current browser. Idempotent;
 * best-effort. Call synchronously at background top level on every spawn.
 *
 * The endpoint list is remote-config-tunable (`web.antiCsrf`) so a Steam-side path change is a config
 * fix. We apply the compiled defaults immediately (the snapshot holds them until the cache loads —
 * important because the core's session refresh can fire early), then re-apply once the Remote Config
 * cache is loaded and on every subsequent change. Rule ids stay fixed (id 1 is the core's per-trade
 * send rule and is validated out of any override).
 */
export function installSteamAntiCsrf(): void {
  void applyAntiCsrf();
  void loadSettings().then(() => applyAntiCsrf());
  subscribeSettings(() => {
    void applyAntiCsrf();
  });
}

async function applyAntiCsrf(): Promise<void> {
  const endpoints = getSettings().web.antiCsrf;
  if (import.meta.env.FIREFOX) {
    installViaWebRequest(endpoints);
  } else {
    await installViaDnr(endpoints);
  }
}

// ---- Chrome: declarativeNetRequest session rules ---------------------------------------------------

// Ids we last installed, so a re-application (Remote Config change) removes the previous set even if the
// override changes which ids are present.
let installedRuleIds: number[] = [];

async function installViaDnr(endpoints: AntiCsrfEndpoint[]): Promise<void> {
  const rules: Browser.declarativeNetRequest.Rule[] = endpoints.map((ep) => {
    const site = SITES[ep.site];
    return {
      id: ep.ruleId,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'referer', operation: 'set', value: site.referer },
          { header: 'origin', operation: 'set', value: site.origin },
        ],
      },
      condition: { urlFilter: `||${ep.host}${ep.path}`, resourceTypes: ['xmlhttprequest', 'other'] },
    };
  });

  const newIds = rules.map((r) => r.id);
  const removeRuleIds = [...new Set([...installedRuleIds, ...newIds])];
  try {
    await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules: rules });
    installedRuleIds = newIds;
  } catch (error) {
    // P0. Without these rewrites Steam answers the session re-mint with {"success":false,"error":8} (see
    // the module header), so the extension quietly stops being able to keep a Steam session alive at all.
    console.error('[dmarket-p2p] failed to install Steam anti-CSRF rules', error);
    reportError(error);
  }
}

// ---- Firefox: blocking webRequest ------------------------------------------------------------------

/**
 * Rewrite Origin/Referer to the first-party host Steam expects. `store.steampowered.com/login/settoken`
 * uses the store origin; everything else — community settoken/cancel and the `login.steampowered.com`
 * ajaxrefresh (issued with `redir=community`) — uses the community origin. The endpoint→site mapping is
 * read live from settings so a Remote Config change takes effect without re-registering the listener.
 */
function rewriteHeaders(
  details: Browser.webRequest.OnBeforeSendHeadersDetails,
): Browser.webRequest.BlockingResponse {
  const hostname = new URL(details.url).hostname;
  const endpoint = getSettings().web.antiCsrf.find((ep) => ep.host === hostname);
  const site = SITES[endpoint?.site ?? 'community'];
  const headers = (details.requestHeaders ?? []).filter((h) => {
    const name = h.name.toLowerCase();
    return name !== 'origin' && name !== 'referer';
  });
  headers.push({ name: 'Origin', value: site.origin }, { name: 'Referer', value: site.referer });
  return { requestHeaders: headers };
}

// The currently-registered listener, so a re-application (Remote Config change) can swap the URL filter
// without stacking listeners.
let currentListener: ((d: Browser.webRequest.OnBeforeSendHeadersDetails) => Browser.webRequest.BlockingResponse) | undefined;

function installViaWebRequest(endpoints: AntiCsrfEndpoint[]): void {
  try {
    if (currentListener) {
      browser.webRequest.onBeforeSendHeaders.removeListener(currentListener);
      currentListener = undefined;
    }
    const urls = endpoints.map((ep) => `*://${ep.host}${ep.path}*`);
    if (urls.length === 0) return;
    const listener = (details: Browser.webRequest.OnBeforeSendHeadersDetails) => rewriteHeaders(details);
    browser.webRequest.onBeforeSendHeaders.addListener(listener, { urls }, ['blocking', 'requestHeaders']);
    currentListener = listener;
  } catch (error) {
    // P0 — see installViaDnr.
    console.error('[dmarket-p2p] failed to install Steam anti-CSRF webRequest listener', error);
    reportError(error);
  }
}
