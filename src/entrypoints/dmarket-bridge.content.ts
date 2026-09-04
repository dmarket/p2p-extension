import { installDmarketBridge } from '@/messaging/bridge';
import { DMARKET_ORIGINS, getSettings, loadSettings } from '@/config/settings';
import { reportError, setReportContext } from '@/infra/report/reporter';

// Intake bridge on dmarket.com. It never receives secrets — it relays presence/create/nudge requests
// to the service worker, posts replies back to the page, and relays SW-initiated account-mismatch
// pushes. `matches` covers the production origins; debug builds also get the dev/stage FE origins
// appended (see the `build:manifestGenerated` hook in wxt.config.ts) so this script runs there too.

// The page's own origin is always accepted (this script only runs on manifest-matched hosts). This
// list adds extra cross-window origins: the two dmarket origins (DMARKET_ORIGINS), plus any
// remote-config extra origins (`web.bridgeExtraOrigins`, all builds), plus — in debug builds only —
// the dev FE origins the debug console recorded (`debug.allowedOrigins`). A configurable allow-list,
// never a single hardcoded origin.
async function resolveAllowedOrigins(): Promise<string[]> {
  await loadSettings();
  const extra = [...getSettings().web.bridgeExtraOrigins];
  if (import.meta.env.DEV) {
    try {
      const stored = (await browser.storage.local.get('debug.allowedOrigins'))['debug.allowedOrigins'];
      if (Array.isArray(stored)) for (const o of stored) if (typeof o === 'string') extra.push(o);
    } catch {
      /* ignore */
    }
  }
  return [...DMARKET_ORIGINS, ...extra];
}

export default defineContentScript({
  matches: ['https://dmarket.com/*', 'https://www.dmarket.com/*'],
  runAt: 'document_idle',
  // Keep WXT's own start-up announcement OFF the page channel. Its takeover mechanism (see `main`) is a
  // document CustomEvent; this flag only suppresses the legacy `window.postMessage` twin of it, which WXT
  // keeps for backwards compatibility and documents as undesirable for pages with message listeners —
  // and which carries the extension id, untagged, to the page. It matters more now that we re-inject
  // programmatically (src/background/inject-content-scripts.ts): that frame would land in the FE's
  // `message` listener at install/update time, unannounced, while §6 of the FE contract says the
  // extension→page direction carries `dmarket-ext` frames only. The takeover is unaffected.
  noScriptStartedPostMessage: true,
  async main(ctx) {
    setReportContext('content/dmarket-bridge');
    try {
      // LAST ONE WINS. Besides the browser's declarative injection, this script is also injected
      // programmatically into already-open tabs on install/update (src/background/inject-content-scripts.ts),
      // so one frame can receive it twice — and two live bridges would answer the same `correlation_id`
      // twice. WXT's ContentScriptContext does most of the work: its constructor (which runs before this
      // `main`) dispatches a run-unique `wxt:content-script-started` event, every older context of this
      // entrypoint invalidates itself on it, and the `onInvalidated` below is what tears that bridge down.
      //
      // What it does NOT cover, hence the check: the takeover fires when the NEWER context is constructed,
      // which can be while THIS one is still awaiting its origin list. An `onInvalidated` registered after
      // that abort never fires — an aborted signal ignores new listeners — so a bridge installed past this
      // point would never be torn down at all: two bridges, two `pong`s per ping, for the life of the tab.
      // Not hypothetical; the same shape showed up on the Steam surface as two banners after a re-injection.
      const allowedOrigins = await resolveAllowedOrigins();
      if (ctx.isInvalid) return;
      const uninstall = installDmarketBridge(allowedOrigins);
      ctx.onInvalidated(() => uninstall());
    } catch (error) {
      // See the Steam content script: WXT's wrapper makes this path silent in production.
      reportError(error);
    }
  },
});
