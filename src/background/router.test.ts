import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { registerBridgeRouter } from '@/background/router';
import type { BridgeResponse } from '@/messaging/protocol';

// A ping that lands on a worker still booting the core used to be answered from the defaults: installed,
// activated, nothing blocked, but not tracking. Chrome evicts an idle worker after ~30s, so a quiet page
// usually got that. These tests pin that presence waits for the boot, and that writes do not.

const { blockingReason, isTrackingActive, version, forceHeartbeat, awaitDirectiveOutcome, isActivated, deliverPush } =
  vi.hoisted(() => ({
  blockingReason: vi.fn(() => 'NONE'),
  isTrackingActive: vi.fn(() => true),
  version: vi.fn(() => '1.0.0'),
  forceHeartbeat: vi.fn(() => Promise.resolve()),
  awaitDirectiveOutcome: vi.fn<(handle: unknown, dealId: string, timeoutMs: number) => Promise<unknown>>(() =>
    Promise.resolve({ ok: true, status: 'created' }),
  ),
  isActivated: vi.fn(() => Promise.resolve(true)),
  deliverPush: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/core/tracker', () => ({
  Tracker: { blockingReason, isTrackingActive, version, forceHeartbeat, awaitDirectiveOutcome, deliverPush },
}));
vi.mock('@/state/activation', () => ({ isActivated }));

/** Fire the fake's onMessage listeners the way the page's `runtime.sendMessage` would. Typed
 *  `Promise<unknown>` (as in messaging/bridge.test.ts): the fake resolves with each listener's return
 *  value, and this router's is the `true` that keeps the channel open for its async answer. */
const fire = (
  request: unknown,
  sendResponse: (response: BridgeResponse) => void,
  sender: object = DMARKET_TAB,
): Promise<unknown> => fakeBrowser.runtime.onMessage.trigger(request, sender, sendResponse);

/** The bridge content script on a dmarket.com tab — the only sender the page-facing kinds accept. */
const DMARKET_TAB = { id: fakeBrowser.runtime.id, tab: { url: 'https://dmarket.com/ingame-items' } };

/** A stand-in for the opaque core handle: the router only ever passes it back to the mocked Tracker. */
const HANDLE = { core: true } as never;

interface Booting {
  /** Resolves the boot the way `bootCore()` settling does. */
  settle: () => void;
  /** Swap the live handle the way a Remote Config publish or a debug endpoint switch does. */
  replaceCore: (next: unknown) => void;
  /** The handle the router reads — `undefined` until `settle()` is called, like the real closure. */
  reply: (request: unknown) => Promise<BridgeResponse>;
}

function registerBooting(): Booting {
  let handle: unknown;
  let resolveBoot = (): void => {};
  const booted = new Promise<void>((resolve) => {
    resolveBoot = resolve;
  });
  registerBridgeRouter(() => handle as never, booted);
  return {
    settle: () => {
      handle = HANDLE;
      resolveBoot();
    },
    replaceCore: (next) => {
      handle = next;
    },
    // Resolves when the router actually answers: the listener returns `true` and calls `sendResponse`
    // later, so awaiting the trigger proves nothing.
    reply: (request: unknown) =>
      new Promise<BridgeResponse>((resolve) => {
        void fire(request, resolve);
      }),
  };
}

beforeEach(() => {
  isTrackingActive.mockReturnValue(true);
  blockingReason.mockReturnValue('NONE');
  // Activated is the default; the gate tests opt out for one call each.
  isActivated.mockResolvedValue(true);
  awaitDirectiveOutcome.mockClear();
  // The pong's `version` is read from the manifest, which the fake browser throws on until stubbed.
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'test',
    version: '1.0.5',
    version_name: '1.0.5-beta',
  });
});

describe('the presence pong names the extension build', () => {
  it("reports the extension's version, not the core's", async () => {
    const bridge = registerBooting();
    const pending = bridge.reply({ kind: 'presence' });
    bridge.settle();

    // The core mock answers '1.0.0'. The page is told which extension is installed; the core version
    // follows from it, since each build pins one core.
    expect(await pending).toMatchObject({ ok: true, kind: 'presence', version: '1.0.5-beta' });
  });
});

describe('the presence pong carries the forced-update status', () => {
  it('reports the rule in effect, even for an install that is not activated', async () => {
    const { loadSettings } = await import('@/config/settings');
    const { REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_PARAM } = await import('@/infra/remoteConfig');
    await fakeBrowser.storage.local.set({
      [REMOTE_CONFIG_CACHE_KEY]: { [REMOTE_CONFIG_PARAM]: JSON.stringify({ web: { minExtensionVersion: '1.0.7' } }) },
    });
    await loadSettings();
    isActivated.mockResolvedValueOnce(false);
    const bridge = registerBooting();
    const pending = bridge.reply({ kind: 'presence' });
    bridge.settle();

    // The manifest says 1.0.5, below the minimum; no check has run in this test, hence `checking`.
    expect(await pending).toMatchObject({
      isActivated: false,
      update: { required: true, minVersion: '1.0.7', state: 'checking' },
    });
    // The settings snapshot is module state: put the defaults back for the tests that follow.
    await fakeBrowser.storage.local.clear();
    await loadSettings();
  });
});

// Business rule: during a forced update the trades already in progress keep being tracked and only new offers are
// stopped. The stop is the core's (`setCreatesPaused`, src/background/createsPause.ts): the router does not look at
// the update status, so a deal whose offer this device already made still gets that offer back, and the core's
// `creates_paused` reaches the page as EXT_UPDATE_REQUIRED (src/core/createTradeOutcome.ts).
describe('a required update does not stop the trades already in progress', () => {
  it('still asks the core to create and still runs a requested cycle while the update is restart_required', async () => {
    const { loadSettings } = await import('@/config/settings');
    const { REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_PARAM } = await import('@/infra/remoteConfig');
    await fakeBrowser.storage.local.set({
      [REMOTE_CONFIG_CACHE_KEY]: { [REMOTE_CONFIG_PARAM]: JSON.stringify({ web: { minExtensionVersion: '1.0.7' } }) },
    });
    await fakeBrowser.storage.session.set({ 'update.forced': { min: '1.0.7', state: 'restart_required' } });
    await loadSettings();
    const bridge = registerBooting();
    bridge.settle();

    expect(await bridge.reply({ kind: 'presence' })).toMatchObject({ update: { required: true, state: 'restart_required' } });
    expect(await bridge.reply(CREATE)).toMatchObject({ ok: true, kind: 'create-trade' });
    expect(awaitDirectiveOutcome).toHaveBeenCalledTimes(1);
    // The core's refusal comes back inside the result; the router passes it on untouched.
    awaitDirectiveOutcome.mockResolvedValueOnce({ ok: false, status: 'failed', error: '', reason: 'EXT_UPDATE_REQUIRED' });
    expect(await bridge.reply(CREATE)).toEqual({
      ok: true,
      kind: 'create-trade',
      result: { ok: false, status: 'failed', error: '', reason: 'EXT_UPDATE_REQUIRED' },
    });
    expect(await bridge.reply({ kind: 'request-cycle', dealId: 'deal1' })).toEqual({ ok: true, kind: 'request-cycle' });
    expect(deliverPush).toHaveBeenCalled();

    await fakeBrowser.storage.local.clear();
    await loadSettings();
  });
});

describe('presence pings are the host hook for work that must not wait for a respawn', () => {
  it('calls onPresence on a presence ping, not on writes', async () => {
    const onPresence = vi.fn();
    registerBridgeRouter(() => HANDLE, Promise.resolve(), onPresence);
    await new Promise<BridgeResponse>((resolve) => void fire({ kind: 'presence' }, resolve));
    await new Promise<BridgeResponse>((resolve) => void fire({ kind: 'request-cycle' }, resolve));
    expect(onPresence).toHaveBeenCalledTimes(1);
  });
});

describe('the bridge router waits for the core boot before answering presence', () => {
  it('answers presence with the booted state, not the pre-boot defaults', async () => {
    const bridge = registerBooting();

    const pending = bridge.reply({ kind: 'presence' });
    bridge.settle();

    // `is_tracking_active: true` needs a live handle — before the boot there is nothing to ask.
    expect(await pending).toMatchObject({ ok: true, kind: 'presence', isTrackingActive: true });
    expect(isTrackingActive).toHaveBeenCalledWith(HANDLE);
  });

  it('does not answer presence while the boot is still in flight', async () => {
    registerBooting();
    const sendResponse = vi.fn();

    await fire({ kind: 'presence' }, sendResponse);
    await Promise.resolve();

    // Withheld, not answered wrongly and corrected later: nothing tells the page when the boot lands.
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('answers from the defaults once the wait is capped, so a failed boot still replies', async () => {
    vi.useFakeTimers();
    try {
      const bridge = registerBooting();

      const pending = bridge.reply({ kind: 'presence' });
      await vi.advanceTimersByTimeAsync(1_000);

      // Same wire shape as before: it is what the page's own retry recognises.
      expect(await pending).toMatchObject({ ok: true, isActivated: true, isTrackingActive: false, blockingReason: 'NONE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never makes a create-trade wait: it is already coded for a worker with no core', async () => {
    // Frozen timers, no `settle()`: if this kind waited on the cap the answer could never arrive.
    vi.useFakeTimers();
    const bridge = registerBooting();

    expect(
      await bridge.reply({ kind: 'create-trade', dealId: 'deal1' }),
    ).toEqual({ ok: false, error: 'tracker not started', reason: 'EXT_NOT_READY' });
    vi.useRealTimers();
  });

  it('never makes a request-cycle wait either', async () => {
    vi.useFakeTimers();
    const bridge = registerBooting();

    expect(await bridge.reply({ kind: 'request-cycle' })).toEqual({ ok: false, error: 'tracker not started' });
    vi.useRealTimers();
  });
});

// The activation gate on the write path. The core is now started only for an activated extension
// (src/background/coreLifecycle.ts), so this is belt and braces — but it is the leg that holds if a core
// is ever running for another reason, and it is what gives the page a code it can act on.

const CREATE = { kind: 'create-trade', dealId: 'deal1' } as const;

describe('a not-activated extension refuses to create a trade', () => {
  it('refuses with EXT_NOT_ACTIVATED and attempts no Steam write, even with a live core', async () => {
    const bridge = registerBooting();
    bridge.settle();
    isActivated.mockResolvedValue(false);

    expect(await bridge.reply(CREATE)).toEqual({
      ok: false,
      error: 'extension not activated',
      reason: 'EXT_NOT_ACTIVATED',
    });
    // The defect this closes: a not-activated client used to create the real Steam offer.
    expect(awaitDirectiveOutcome).not.toHaveBeenCalled();
  });

  it('names the activation, not the missing core, when neither is there', async () => {
    // The ordinary shape of an un-onboarded install: no activation AND no handle. `EXT_NOT_READY` would
    // tell the page to retry once the tracker is up, and nothing will ever bring one up here.
    const bridge = registerBooting();
    isActivated.mockResolvedValue(false);

    expect(await bridge.reply(CREATE)).toMatchObject({ reason: 'EXT_NOT_ACTIVATED' });
  });

  it('still creates for an activated one, asking the core for the deal and nothing else', async () => {
    const bridge = registerBooting();
    bridge.settle();

    expect(await bridge.reply(CREATE)).toMatchObject({ ok: true, kind: 'create-trade' });
    // The core builds the offer from the backend's directive for this deal; the deal id is all it is given.
    expect(awaitDirectiveOutcome).toHaveBeenCalledExactlyOnceWith(HANDLE, 'deal1', 30_000);
  });

  it('reports itself as not tracking, with no blocked check to name', async () => {
    // What the page reads while the gate holds. `is_activated: false` is what maps it to
    // "installed, not set up" rather than to the pre-boot startup pong, which claims `is_activated: true`.
    const bridge = registerBooting();
    isActivated.mockResolvedValue(false);
    bridge.settle();

    expect(await bridge.reply({ kind: 'presence' })).toMatchObject({
      ok: true,
      isActivated: false,
      isTrackingActive: false,
      blockingReason: 'NONE',
    });
  });
});

describe('a core replaced mid-request', () => {
  it('creates against the live core, not the one the request arrived on', async () => {
    // The activation read yields, and a Remote Config publish or a debug endpoint switch can replace the
    // core inside that window. A handle snapshotted before the read would put this write on the STOPPED
    // core and fail a create the live replacement would have completed.
    const bridge = registerBooting();
    bridge.settle();
    const REPLACEMENT = { core: 'replacement' } as never;

    let release!: (activated: boolean) => void;
    isActivated.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );

    const pending = bridge.reply(CREATE);
    await Promise.resolve();
    bridge.replaceCore(REPLACEMENT);
    release(true);

    expect(await pending).toMatchObject({ ok: true, kind: 'create-trade' });
    expect(awaitDirectiveOutcome).toHaveBeenCalledWith(REPLACEMENT, 'deal1', 30_000);
  });
});

describe('the bridge refuses senders that are not a dmarket tab of this extension', () => {
  const answerFor = (request: unknown, sender: object): Promise<BridgeResponse> =>
    new Promise((resolve) => {
      registerBridgeRouter(() => HANDLE, Promise.resolve());
      void fire(request, resolve, sender);
    });
  const REFUSED = { ok: false, error: 'sender not allowed', reason: 'OTHER' };

  it.each([
    ['another extension', { id: 'other-extension-id', tab: { url: 'https://dmarket.com/' } }],
    ['a foreign origin', { id: fakeBrowser.runtime.id, tab: { url: 'https://evil.example/' } }],
    ['the Steam content script', { id: fakeBrowser.runtime.id, tab: { url: 'https://steamcommunity.com/id/x/tradeoffers/' } }],
    ['no url at all', { id: fakeBrowser.runtime.id }],
  ])('create-trade from %s', async (_name, sender) => {
    awaitDirectiveOutcome.mockClear();
    expect(await answerFor(CREATE, sender)).toEqual(REFUSED);
    expect(awaitDirectiveOutcome).not.toHaveBeenCalled();
  });

  it('presence from a foreign origin', async () => {
    expect(await answerFor({ kind: 'presence' }, { id: fakeBrowser.runtime.id, url: 'https://evil.example/' })).toEqual(
      REFUSED,
    );
  });

  it('request-cycle needs only our extension id', async () => {
    expect(await answerFor({ kind: 'request-cycle' }, { id: 'other-extension-id' })).toEqual(REFUSED);
    expect(await answerFor({ kind: 'request-cycle' }, { id: fakeBrowser.runtime.id })).toMatchObject({ ok: true });
  });

  describe('an FE origin the debug console applied (debug.allowedOrigins)', () => {
    const APPLIED = { id: fakeBrowser.runtime.id, tab: { url: 'https://main-dmarket.dev.example/ingame-items' } };
    const record = () => fakeBrowser.storage.local.set({ 'debug.allowedOrigins': ['https://main-dmarket.dev.example'] });

    it('is refused until the console records it', async () => {
      expect(await answerFor({ kind: 'presence' }, APPLIED)).toEqual(REFUSED);
      await record();
      expect(await answerFor({ kind: 'presence' }, APPLIED)).toMatchObject({ ok: true, kind: 'presence' });
      await fakeBrowser.storage.local.remove('debug.allowedOrigins');
    });

    it('is refused by a production build even when recorded', async () => {
      vi.stubEnv('DEV', false);
      await record();
      expect(await answerFor(CREATE, APPLIED)).toEqual(REFUSED);
      await fakeBrowser.storage.local.remove('debug.allowedOrigins');
    });
  });

  it('create-trade from www.dmarket.com still reaches the core', async () => {
    awaitDirectiveOutcome.mockClear();
    const sender = { id: fakeBrowser.runtime.id, tab: { url: 'https://www.dmarket.com/x' } };
    expect(await answerFor(CREATE, sender)).toMatchObject({ ok: true, kind: 'create-trade' });
    expect(awaitDirectiveOutcome).toHaveBeenCalledTimes(1);
  });
});
