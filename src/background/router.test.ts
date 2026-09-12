import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { registerBridgeRouter } from '@/background/router';
import type { BridgeResponse } from '@/messaging/protocol';

// A ping that lands on a worker still booting the core used to be answered from the defaults: installed,
// activated, nothing blocked, but not tracking. Chrome evicts an idle worker after ~30s, so a quiet page
// usually got that. These tests pin that presence waits for the boot, and that writes do not.

const { blockingReason, isTrackingActive, version, forceHeartbeat, createTrade, isActivated } = vi.hoisted(() => ({
  blockingReason: vi.fn(() => 'NONE'),
  isTrackingActive: vi.fn(() => true),
  version: vi.fn(() => '1.0.0'),
  forceHeartbeat: vi.fn(() => Promise.resolve()),
  createTrade: vi.fn(() => Promise.resolve({ ok: true, status: 'created' })),
  isActivated: vi.fn(() => Promise.resolve(true)),
}));
vi.mock('@/core/tracker', () => ({
  Tracker: { blockingReason, isTrackingActive, version, forceHeartbeat, createTrade },
}));
vi.mock('@/state/activation', () => ({ isActivated }));
vi.mock('@/config/settings', () => ({ getSettings: () => ({ web: { reconnectDebounceMs: 3_000 } }) }));

/** Fire the fake's onMessage listeners the way the page's `runtime.sendMessage` would. Typed
 *  `Promise<unknown>` (as in messaging/bridge.test.ts): the fake resolves with each listener's return
 *  value, and this router's is the `true` that keeps the channel open for its async answer. */
const fire = (request: unknown, sendResponse: (response: BridgeResponse) => void): Promise<unknown> =>
  fakeBrowser.runtime.onMessage.trigger(request, {}, sendResponse);

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
  createTrade.mockClear();
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
      await bridge.reply({
        kind: 'create-trade',
        directiveId: 'd1',
        dealId: 'deal1',
        partnerSteamId: '7656119',
        assetIds: ['a1'],
        tradeToken: 't',
        linkedSteamId: '7656119',
      }),
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

const CREATE = {
  kind: 'create-trade',
  directiveId: 'd1',
  dealId: 'deal1',
  partnerSteamId: '7656119',
  assetIds: ['a1'],
  tradeToken: 't',
  linkedSteamId: '7656119',
} as const;

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
    expect(createTrade).not.toHaveBeenCalled();
  });

  it('names the activation, not the missing core, when neither is there', async () => {
    // The ordinary shape of an un-onboarded install: no activation AND no handle. `EXT_NOT_READY` would
    // tell the page to retry once the tracker is up, and nothing will ever bring one up here.
    const bridge = registerBooting();
    isActivated.mockResolvedValue(false);

    expect(await bridge.reply(CREATE)).toMatchObject({ reason: 'EXT_NOT_ACTIVATED' });
  });

  it('still creates for an activated one', async () => {
    const bridge = registerBooting();
    bridge.settle();

    expect(await bridge.reply(CREATE)).toMatchObject({ ok: true, kind: 'create-trade' });
    expect(createTrade).toHaveBeenCalledTimes(1);
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
    expect(createTrade).toHaveBeenCalledWith(REPLACEMENT, expect.anything());
  });
});
