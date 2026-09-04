// Re-inject this extension's content scripts into ALREADY-OPEN matching tabs, on install and on update.
//
// THE GAP THIS CLOSES. A declarative content script is injected by the browser only into pages loaded
// AFTER the extension is installed. Every tab the user already had open therefore runs none of our
// on-page code until they reload it — and neither surface tells them to:
//
//   - **dmarket.com (the page bridge).** The tab the seller was on when the FE told them "install the
//     extension" — the purchase flow's own tab — has no bridge: nothing is listening for the FE's
//     `RequestPresence`, every ping times out, and the FE keeps rendering the install prompt over a
//     perfectly working install. From the seller's side that reads as a failed install (reinstall →
//     support ticket), which is the defect the FE-facing spec calls out as "recovery phrased as a first
//     install".
//   - **steamcommunity.com trade offers (the banner + onboarding).** Same tab-was-already-open story,
//     and the onboarding banner is *how the user activates the extension* — so its absence is not
//     cosmetic: the seller stays un-activated, and the FE keeps showing the activation nudge.
//
// UPDATE IS THE SAME BUG, ONE STEP WORSE. On an extension update the browser tears down the old content
// script in every open tab and does NOT inject the new one. The page keeps the JS objects the old script
// left behind while `browser.runtime` under them is dead (see the orphan check in messaging/bridge.ts),
// so the script is silently inert — identical to "not installed", except this time nothing prompted the
// user to do anything. Hence both reasons are handled here; `chrome_update` / `browser_update` are not
// (the browser reloads pages on its own restart anyway).
//
// WHAT IT DOES NOT DO — and why the FE change is still required for the install prompt. Injection lands
// a second or two after the FE has already asked and timed out, and the protocol has no unsolicited
// "the extension is here now" frame: presence is always FE-initiated. So this only clears the prompt for
// a FE that keeps pinging `RequestPresence` while it believes no extension is present. Same for the
// cases below, which no injection can reach:
//   - discarded/frozen tabs — skipped here; the browser reloads them when the user returns, which
//     injects the scripts the normal way,
//   - a tab whose origin is outside `host_permissions` (never had our scripts to begin with),
//   - the extension being disabled and re-enabled (no `onInstalled`, and no event we can see without the
//     `management` permission).
//
// MANIFEST-DRIVEN, deliberately. The target tabs and the files to inject are read from the generated
// manifest's own `content_scripts` entries instead of being hardcoded, so: the dev/stage FE origins the
// `build:manifestGenerated` hook appends (wxt.config.ts) are covered for free, a renamed bundle can't
// leave this silently injecting nothing, and a content script added later is picked up with no edit
// here. Remote-config `bridgeExtraOrigins` are intentionally NOT included: they only widen which origins
// may TALK to the bridge, and no bridge is ever injected there declaratively either.
//
// RE-INJECTING OVER A LIVE SCRIPT IS SAFE, and that is WXT's doing, not luck: a fresh
// ContentScriptContext invalidates every older context of the same entrypoint (a document CustomEvent
// dispatched from its constructor, before `main` runs), which triggers that instance's teardown. So the
// bridge can never end up with two listeners answering one `correlation_id`, and the Steam UI can never
// end up with two banners — the new one replaces the old (`createShadowRootUi` removes itself on
// invalidation).

import { reportError } from '@/infra/report/reporter';

type ManifestContentScript = {
  js?: string[];
  css?: string[];
  matches?: string[];
  all_frames?: boolean;
};

/**
 * WXT types `scripting.executeScript`'s `files` as a literal union of the build's public paths. Ours are
 * read from the manifest at RUNTIME (the whole point — see the header), so that literal type can never
 * apply; this alias keeps the one unavoidable cast tied to the real signature. What actually validates
 * the paths is that the manifest entry is generated from the very bundles we want to inject.
 */
type InjectionFiles = NonNullable<Parameters<typeof browser.scripting.executeScript>[0]['files']>;

/** One manifest content script's result: how many open tabs it was injected into. */
export interface InjectionCount {
  /** First bundle path of the entry — enough to name it in a log line. */
  script: string;
  tabs: number;
}

/**
 * Inject one manifest content-script entry into every open tab it matches. Best-effort per tab: a tab
 * that navigated away, closed mid-send, or sits on a URL we hold no permission for just rejects, and the
 * rest still get injected. CSS declared in the manifest goes in first, so a UI script never paints
 * unstyled. No entry declares any today (the Steam UI runs `cssInjectionMode: 'ui'`, i.e. it fetches its
 * own web-accessible stylesheet into its shadow root — which works the same however the script got
 * there), but an entry that does must not be injected half-dressed.
 */
async function injectOne(cs: ManifestContentScript, files: string[]): Promise<number> {
  const allFrames = cs.all_frames === true;
  const css = cs.css?.length ? (cs.css as unknown as InjectionFiles) : undefined;
  const tabs = await browser.tabs.query({ url: cs.matches });
  const injected = await Promise.all(
    tabs.map(async (tab) => {
      // A discarded tab has no live document to inject into; it reloads (and gets the scripts normally)
      // when the user comes back to it.
      if (tab.id === undefined || tab.discarded) return false;
      const target = { tabId: tab.id, allFrames };
      try {
        if (css) await browser.scripting.insertCSS({ target, files: css });
        await browser.scripting.executeScript({ target, files: files as unknown as InjectionFiles });
        return true;
      } catch {
        /* navigated away / closed / not injectable — the other tabs still count */
        return false;
      }
    }),
  );
  return injected.filter(Boolean).length;
}

/**
 * Inject every manifest content script into the open tabs it matches. Returns one count per entry (the
 * log line's material), including zeros — "nothing was open" and "nothing could be injected" are both
 * useful to see. Never rejects for a single bad entry: each is queried and injected independently, so a
 * malformed match pattern in one cannot cost the others their injection.
 */
export async function injectContentScriptsIntoOpenTabs(): Promise<InjectionCount[]> {
  const manifest = browser.runtime.getManifest() as { content_scripts?: ManifestContentScript[] };
  const entries = manifest.content_scripts ?? [];
  if (entries.length === 0) {
    // The manifest declares no content scripts at all — a build regression, and one that is invisible
    // from the outside (the install prompt just never clears). Worth a report, not a throw.
    reportError(new Error('no content_scripts in the manifest — nothing to re-inject'));
    return [];
  }
  const results = await Promise.all(
    entries.map(async (cs): Promise<InjectionCount | undefined> => {
      const files = cs.js ?? [];
      const [script] = files;
      // A CSS-only entry (no `js`) has nothing to execute, and an entry with no `matches` has nowhere to
      // go — neither is an error, both are simply not ours to inject.
      if (script === undefined || !cs.matches?.length) return undefined;
      try {
        return { script, tabs: await injectOne(cs, files) };
      } catch (error) {
        // `tabs.query` rejected (an unparseable match pattern is the realistic cause) — report and let
        // the other entries proceed.
        reportError(error);
        return undefined;
      }
    }),
  );
  return results.filter((r): r is InjectionCount => r !== undefined);
}

/**
 * Register the install/update re-injection. Call synchronously on every worker spawn (like every other
 * listener in the background entrypoint): `onInstalled` fires once, at a moment when the worker may not
 * be running yet, and only a listener registered at top level wakes it.
 */
export function registerContentScriptInjection(): void {
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason !== 'install' && details.reason !== 'update') return;
    void injectContentScriptsIntoOpenTabs()
      .then((counts) => {
        const injected = counts.filter((c) => c.tabs > 0);
        if (injected.length > 0) {
          console.info('[dmarket-p2p] content scripts re-injected into open tabs', {
            reason: details.reason,
            ...Object.fromEntries(injected.map((c) => [c.script, c.tabs])),
          });
        }
      })
      .catch((error: unknown) => {
        // Not fatal — a user reloading the page still gets the scripts — but it silently reinstates the
        // very bug this exists to fix, so it must not be swallowed.
        reportError(error);
      });
  });
}
