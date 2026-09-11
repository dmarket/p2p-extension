import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { injectContentScriptsIntoOpenTabs } from '@/background/inject-content-scripts';

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

// A fresh module instance per test is a fresh worker: the one-pass-per-worker guard is module state, so
// a static import would carry one test's pass into the next.
const freshWorker = async () => {
  vi.resetModules();
  return import('@/background/inject-content-scripts');
};

/** The three APIs every trigger test needs stubbed, plus the tab query the assertions read. */
const stubWorld = () => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  stubManifest([BRIDGE]);
  const query = stubTabs({ id: 1 });
  stubInjection();
  return query;
};

describe('the install/update trigger', () => {
  const trigger = async (reason: string) => {
    const query = stubWorld();
    const { registerContentScriptInjection } = await freshWorker();
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

// The case `onInstalled` cannot see: disabled, then re-enabled. Enabling boots a worker, so the first
// spawn of a browser session is the trigger — once, since each pass rebuilds every matching tab's script.
describe('the session trigger', () => {
  const SESSION_KEY = 'inject.doneForBrowserSession';

  it('injects on the first worker spawn of a browser session', async () => {
    const query = stubWorld();
    const { injectContentScriptsOnSessionStart } = await freshWorker();

    await injectContentScriptsOnSessionStart();

    expect(query).toHaveBeenCalledOnce();
    expect((await fakeBrowser.storage.session.get(SESSION_KEY))[SESSION_KEY]).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('does not inject again on an idle respawn in the same session', async () => {
    await fakeBrowser.storage.session.set({ [SESSION_KEY]: true });
    const query = stubWorld();
    const { injectContentScriptsOnSessionStart } = await freshWorker();

    await injectContentScriptsOnSessionStart();

    // A presence ping is enough to wake a worker, so this runs every few seconds on an active page.
    expect(query).not.toHaveBeenCalled();
  });

  it('still injects on an update, even though this session was already marked', async () => {
    await fakeBrowser.storage.session.set({ [SESSION_KEY]: true });
    const query = stubWorld();
    const { registerContentScriptInjection, injectContentScriptsOnSessionStart } = await freshWorker();
    registerContentScriptInjection();

    await injectContentScriptsOnSessionStart();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'update' } as never);

    // An update orphans every open tab, so the install trigger must not be suppressed by the mark.
    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  });

  it('runs ONE pass when both triggers fire on a fresh install', async () => {
    const query = stubWorld();
    const { registerContentScriptInjection, injectContentScriptsOnSessionStart } = await freshWorker();
    registerContentScriptInjection();

    // Both fire in the same burst on a real install; a second pass would undo the first.
    const spawn = injectContentScriptsOnSessionStart();
    await fakeBrowser.runtime.onInstalled.trigger({ reason: 'install' } as never);
    await spawn;

    await vi.waitFor(() => expect(query).toHaveBeenCalledOnce());
  });

  it('leaves the session unmarked when the pass could not run, so the next spawn retries', async () => {
    stubWorld();
    vi.spyOn(runtimeHost(), 'getManifest').mockImplementation(() => {
      throw new Error('no manifest');
    });
    const { injectContentScriptsOnSessionStart } = await freshWorker();

    await injectContentScriptsOnSessionStart();

    // The mark means "re-injected", not "tried": a worker killed mid-pass must not strand the session.
    expect((await fakeBrowser.storage.session.get(SESSION_KEY))[SESSION_KEY]).toBeUndefined();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('injects anyway when session storage is unavailable, and reports it', async () => {
    const query = stubWorld();
    vi.spyOn(fakeBrowser.storage.session, 'get').mockRejectedValue(new Error('storage unavailable'));
    const { injectContentScriptsOnSessionStart } = await freshWorker();

    await injectContentScriptsOnSessionStart();

    // An extra pass is cheaper than leaving a re-enabled extension unreachable until the user reloads.
    expect(query).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
