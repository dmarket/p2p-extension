import { render } from 'preact';
import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/latin-600.css';
import '@fontsource/montserrat/latin-700.css';
import '@/ui/steam/steam.css';
import { getSettings, loadSettings, subscribeSettings } from '@/config/settings';
import { reportError, setReportContext } from '@/infra/report/reporter';
import { SteamApp } from '@/ui/steam/SteamApp';

// Steam redirects /my/tradeoffers to the logged-in user's canonical profile URL, so both /profiles/
// and /id/ forms must be matched. NOTE: WXT statically analyses these patterns at build time, so they
// must stay inline literals — keep them in sync with STEAM_INTEGRATION.tradeOffersMatchPatterns.
export default defineContentScript({
  matches: [
    'https://steamcommunity.com/profiles/*/tradeoffers*',
    'https://steamcommunity.com/id/*/tradeoffers*',
  ],
  cssInjectionMode: 'ui',
  runAt: 'document_idle',
  // Same reasoning as the dmarket bridge: suppress the legacy `window.postMessage` twin of WXT's
  // start-up announcement (the takeover itself is a document CustomEvent and is unaffected). It carries
  // the extension id into a THIRD-PARTY page whose own message listeners we do not control, and since
  // this script is now also injected programmatically on install/update
  // (src/background/inject-content-scripts.ts) it would fire at arbitrary times, not just on page load.
  noScriptStartedPostMessage: true,
  async main(ctx) {
    setReportContext('content/steam-tradeoffers');
    try {
      await mount(ctx);
    } catch (error) {
      // WXT's own content-script wrapper rethrows into an async IIFE nobody holds, and its logger is
      // compiled out of production — so without this catch a failure here is completely silent in a
      // release build. No global hooks are installed: Chrome world-tags error events, so they would add
      // nothing, and this is the one path that is actually unreported.
      reportError(error);
    }
  },
});

/** The shadow host `createShadowRootUi` builds for us — a tag name nothing else on the page uses. */
const HOST_TAG = 'dmarket-trade-tracker';

/**
 * Tags earlier releases of THIS extension used for the same host, swept alongside the current one.
 * The update that renames the tag is the one case the sweep below could otherwise miss: the previous
 * instance is torn down by the browser and re-injection mounts ours beside its orphaned host, which no
 * longer matches `HOST_TAG`. Append here on any future rename; entries can be dropped once no installed
 * build still mounts them.
 */
const LEGACY_HOST_TAGS = ['dmarket-checker', 'dmarket-p2p-agent'];

/**
 * Drop any shadow host a PREVIOUS instance of this script left in the page, immediately before mounting
 * ours. The DOM is the only state still trustworthy at that moment, and this is the guard that actually
 * holds "one banner, always".
 *
 * WXT's newer-script takeover is supposed to do this for us: a fresh ContentScriptContext invalidates the
 * older one, and `createShadowRootUi` removes its host on invalidation. That path is real but NOT
 * sufficient, and the failure it has is one only re-injection can reach — the old instance is usually an
 * ORPHAN (extension reloaded/updated, its `browser.*` bindings dead), and WXT's removal runs our
 * `onRemove` FIRST: one throw in there (a Preact unmount is arbitrary user code) and `shadowHost.remove()`
 * is never reached. The banner then stays, ours mounts beside it, and the user sees two. `onRemove` is now
 * individually guarded as well, but a teardown that must not fail is a teardown that should not be the
 * only mechanism.
 *
 * Only our own tag is touched — never WXT's document-level `<style wxt-shadow-root-document-styles>`,
 * whose attribute is not namespaced to this extension (a duplicate of it is inert; deleting another
 * extension's is not).
 */
function removeStaleHosts(): void {
  for (const tag of [HOST_TAG, ...LEGACY_HOST_TAGS]) {
    for (const host of document.querySelectorAll(tag)) host.remove();
  }
}

/** Extracted from `main` only so the entrypoint can wrap it — see the catch there. */
async function mount(ctx: InstanceType<typeof ContentScriptContext>): Promise<void> {
  // Load the remote-config snapshot BEFORE mounting so the banner anchor selector, logout expression,
  // and marketing link reflect any override on first paint; then subscribe to keep it live.
  await loadSettings();
  // A NEWER instance of this script may have invalidated us while that await was in flight — which is
  // precisely what the re-injection in src/background/inject-content-scripts.ts does to a script that is
  // still starting up. Bail instead of mounting: `ctx.onInvalidated` on an already-aborted signal never
  // fires, so anything mounted past this point would have no teardown at all and would sit on the page
  // for as long as the tab lives, next to the new instance's banner.
  if (ctx.isInvalid) return;
  const unsubscribeSettings = subscribeSettings();
  ctx.onInvalidated(() => unsubscribeSettings());
  // The UI is persistent: SteamApp renders the onboarding banner before activation, the
  // "Trade tracking is ON" banner after, and the "Wrong Steam account" banner on a mismatch — all
  // driven reactively from shared storage state, so the entrypoint just mounts and stays mounted.
  const ui = await createShadowRootUi(ctx, {
    // Shared with removeStaleHosts — the cleanup only works while both name the same element.
    name: HOST_TAG,
    position: 'inline',
    // Top of the main content area so the banner spans the page width. The selector is
    // remote-config-tunable; guard against an invalid selector string throwing (fall back to body).
    anchor: () => {
      try {
        return document.querySelector(getSettings().web.bannerAnchorSelector) ?? 'body';
      } catch {
        return 'body';
      }
    },
    append: 'first',
    onMount(container) {
      render(<SteamApp />, container);
      return container;
    },
    onRemove(container) {
      // Guarded because of WHERE this runs: WXT calls it first inside its own teardown, and the teardown
      // that matters most fires in an ORPHANED context (extension reloaded/updated) — so every hook
      // cleanup in the tree runs against dead `browser.*` bindings. The storage listeners those cleanups
      // remove no longer throw there (src/util/storageEvents.ts absorbs it), but unmounting a tree runs
      // arbitrary code, and one throw here would skip `shadowHost.remove()` and strand the banner.
      try {
        if (container) render(null, container);
      } catch {
        /* dead extension bindings — let WXT get on with removing the host */
      }
    },
  });

  // Same reason as after `loadSettings` — createShadowRootUi awaits its CSS fetch, so the takeover can
  // land here too. Nothing has been appended to the page yet (the host is built detached and only
  // `mount()` inserts it), so returning leaves no trace; the settings subscription is ours to undo.
  if (ctx.isInvalid) {
    unsubscribeSettings();
    return;
  }

  // Last-instance-wins, enforced on the DOM right before we insert ours (see removeStaleHosts).
  removeStaleHosts();
  ui.mount();

  // Give WXT's invalidation check something to fire on. The banner's only update channel is
  // `storage.onChanged` (SteamApp -> state/blocking.ts), and when the extension is reloaded or updated
  // this content script is orphaned: its listener never fires again, so whatever it last rendered — a
  // "Wrong Steam account" banner, say — freezes on the page forever, even after the user fixes the
  // account elsewhere. WXT *does* tear the shadow UI down on invalidation (`ctx.onInvalidated(remove)`
  // inside createShadowRootUi), but it only NOTICES lazily: reading `ctx.isInvalid` is what checks
  // `browser.runtime?.id` and triggers the teardown, and nothing else here ever reads it (a reload does
  // not re-inject into already-open tabs, so the newer-script signal never arrives either).
  //
  // Hooked to the moments the user could be looking at a stale banner rather than to a timer: coming back
  // to the tab is exactly the flow that matters (fix the account in another tab, return to this one). One
  // property read, no storage, no messaging, no heartbeat — the "heartbeats are never view-driven" rule is
  // untouched. A live context needs nothing more: `storage.onChanged` reaches a hidden tab too, so there
  // is never a missed update to re-read. Registered through ctx so it unregisters itself on invalidation.
  const dropUiIfOrphaned = (): void => {
    void ctx.isInvalid;
  };
  ctx.addEventListener(document, 'visibilitychange', () => {
    if (document.visibilityState === 'visible') dropUiIfOrphaned();
  });
  ctx.addEventListener(window, 'focus', dropUiIfOrphaned);
}
