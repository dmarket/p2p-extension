import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  injectContentScriptsIntoOpenTabs,
  registerContentScriptInjection,
} from '@/background/inject-content-scripts';

// The install/update re-injection is what makes the FE's install prompt clearable without a page reload,
// and its failure mode is silence: nothing throws, the prompt just stays up. It also carries the whole
// weight of dropping the `tabs` permission — the tab set it acts on comes from a `tabs.query({ url })`
// whose filter is honoured through `host_permissions`, and it must never need a privileged `Tab` field.
// Hence the third test below: if a future edit starts reading `tab.url`, the manifest needs `tabs` back
// and every user gets a "Read your browsing history" re-consent prompt. That regression should fail here,
// not in a store review.

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock('@/infra/report/reporter', () => ({ reportError }));

// `restoreMocks` (vitest.config.ts) restores vi.spyOn spies, not a module-level `vi.fn()` — its call log
// would otherwise carry into the next test, and "was not reported" is an assertion several tests make.
beforeEach(() => {
  reportError.mockClear();
});

// Minimal shapes of the three APIs under test, cast onto fakeBrowser. Spelling vi.spyOn's generics against
// the real WebExtension overloads resolves the callback-style signature (which returns void), and then
// `mockResolvedValue` does not type-check — the same reason messaging/bridge.test.ts casts sendMessage.
// `scripting` is a `notMockedFunction` in fake-browser, so it only exists once spied on.
type QueriedTab = { id?: number; discarded?: boolean };
type TabsHost = { query(info: { url?: string | string[] }): Promise<QueriedTab[]> };
type Target = { tabId: number; allFrames: boolean };
type ScriptingHost = {
  executeScript(i: { target: Target; files: string[] }): Promise<unknown>;
  insertCSS(i: { target: Target; files: string[] }): Promise<void>;
};
type ManifestHost = { getManifest(): { content_scripts?: unknown[] } };

const tabsHost = () => fakeBrowser.tabs as unknown as TabsHost;
const scriptingHost = () => fakeBrowser.scripting as unknown as ScriptingHost;
const runtimeHost = () => fakeBrowser.runtime as unknown as ManifestHost;

const stubManifest = (entries: unknown[]) =>
  vi.spyOn(runtimeHost(), 'getManifest').mockReturnValue({ content_scripts: entries });

const stubTabs = (...tabs: QueriedTab[]) => vi.spyOn(tabsHost(), 'query').mockResolvedValue(tabs);

const stubInjection = () => ({
  executeScript: vi.spyOn(scriptingHost(), 'executeScript').mockResolvedValue(undefined),
  insertCSS: vi.spyOn(scriptingHost(), 'insertCSS').mockResolvedValue(undefined),
});

const BRIDGE = { js: ['dmarket-bridge.js'], matches: ['https://dmarket.com/*'] };
const BANNER = {
  js: ['steam-tradeoffers.js'],
  matches: ['https://steamcommunity.com/*'],
  all_frames: true,
};

describe('re-injecting content scripts into already-open tabs', () => {
  it('queries each manifest entry by its own match patterns', async () => {
    stubManifest([BRIDGE, BANNER]);
    const query = stubTabs({ id: 1 });
    const { executeScript } = stubInjection();

    await injectContentScriptsIntoOpenTabs();

    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledWith({ url: BRIDGE.matches });
    expect(query).toHaveBeenCalledWith({ url: BANNER.matches });
    // The entry's own files and its `all_frames` travel with it — a shared default would inject the
    // bridge into Steam's frames or the banner into none of dmarket's.
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, allFrames: false },
      files: BRIDGE.js,
    });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, allFrames: true },
      files: BANNER.js,
    });
  });

  it('counts the tabs it injected, per entry', async () => {
    stubManifest([BRIDGE]);
    stubTabs({ id: 1 }, { id: 2 }, { id: 3 });
    stubInjection();

    await expect(injectContentScriptsIntoOpenTabs()).resolves.toEqual([
      { script: 'dmarket-bridge.js', tabs: 3 },
    ]);
  });

  it('needs no privileged Tab field — id and discarded are the whole contract', async () => {
    // Exactly what a query returns when the extension holds host permission rather than `tabs`: no
    // `url`, no `title`, no `favIconUrl`. Injection must still happen.
    stubManifest([BRIDGE]);
    stubTabs({ id: 7 });
    const { executeScript } = stubInjection();

    await expect(injectContentScriptsIntoOpenTabs()).resolves.toEqual([
      { script: 'dmarket-bridge.js', tabs: 1 },
    ]);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('skips a tab with no id and a discarded tab', async () => {
    stubManifest([BRIDGE]);
    // A discarded tab has no live document; it gets the scripts the normal way when the user returns.
    stubTabs({ id: 1 }, { id: 2, discarded: true }, {});
    const { executeScript } = stubInjection();

    await expect(injectContentScriptsIntoOpenTabs()).resolves.toEqual([
      { script: 'dmarket-bridge.js', tabs: 1 },
    ]);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, allFrames: false },
      files: BRIDGE.js,
    });
  });

  it('inserts declared CSS before executing the script', async () => {
    const styled = { js: ['ui.js'], css: ['ui.css'], matches: ['https://dmarket.com/*'] };
    stubManifest([styled]);
    stubTabs({ id: 1 });
    const { executeScript, insertCSS } = stubInjection();

    await injectContentScriptsIntoOpenTabs();

    expect(insertCSS).toHaveBeenCalledWith({
      target: { tabId: 1, allFrames: false },
      files: styled.css,
    });
    // Order, not just presence: a UI script that paints before its stylesheet arrives flashes unstyled.
    expect(insertCSS.mock.invocationCallOrder[0]).toBeLessThan(
      executeScript.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('keeps injecting the other tabs when one rejects', async () => {
    stubManifest([BRIDGE]);
    stubTabs({ id: 1 }, { id: 2 }, { id: 3 });
    const { insertCSS } = stubInjection();
    void insertCSS;
    vi.spyOn(scriptingHost(), 'executeScript').mockImplementation((i) =>
      i.target.tabId === 2 ? Promise.reject(new Error('navigated away')) : Promise.resolve(undefined),
    );

    // The tab that navigated away or closed mid-send is not an error — the rest still count, and nothing
    // is reported: a closing tab is not a defect.
    await expect(injectContentScriptsIntoOpenTabs()).resolves.toEqual([
      { script: 'dmarket-bridge.js', tabs: 2 },
    ]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('reports a failed query and still injects the remaining entries', async () => {
    stubManifest([BRIDGE, BANNER]);
    vi.spyOn(tabsHost(), 'query').mockImplementation((info) =>
      info.url === BRIDGE.matches
        ? Promise.reject(new Error('unparseable match pattern'))
        : Promise.resolve([{ id: 9 }]),
    );
    stubInjection();

    // One malformed entry must not cost the others their injection — that is the whole reason the entries
    // are queried independently.
    await expect(injectContentScriptsIntoOpenTabs()).resolves.toEqual([
      { script: 'steam-tradeoffers.js', tabs: 1 },
    ]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('reports a manifest with no content scripts at all', async () => {
    stubManifest([]);

    // A build regression invisible from the outside: the prompt simply never clears. Worth a report.
    await expect(injectContentScriptsIntoOpenTabs()).resolves.toEqual([]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('silently skips entries with no js and entries with no matches', async () => {
    stubManifest([{ css: ['only.css'], matches: ['https://dmarket.com/*'] }, { js: ['nowhere.js'] }]);
    const query = stubTabs({ id: 1 });
    stubInjection();

    // Neither is an error, and neither is ours to inject.
    await expect(injectContentScriptsIntoOpenTabs()).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('the install/update trigger', () => {
  const trigger = async (reason: string) => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    stubManifest([BRIDGE]);
    const query = stubTabs({ id: 1 });
    stubInjection();
    registerContentScriptInjection();

    await fakeBrowser.runtime.onInstalled.trigger({ reason } as never);
    return query;
  };

  it('injects on a fresh install', async () => {
    const query = await trigger('install');
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  });

  it('injects on an extension update — the browser tears the old script down and injects nothing', async () => {
    const query = await trigger('update');
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  });

  it('does nothing on a browser update, which reloads pages by itself', async () => {
    const query = await trigger('chrome_update');
    expect(query).not.toHaveBeenCalled();
  });
});
