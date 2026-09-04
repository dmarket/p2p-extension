import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { installDmarketBridge } from '@/messaging/bridge';
import type { BridgeResponse } from '@/messaging/protocol';
import { flushMacrotasks } from '@/testing/stubs';

// The content-script half of the page bridge: the trust boundary between the untrusted dmarket.com page
// and the service worker. A hand-rolled window stub rather than jsdom (deliberately not a dependency):
// the bridge needs exactly an EventTarget with a recorded postMessage, and building it by hand keeps the
// origin/source plumbing — the thing under test — explicit in the fixtures.

const PAGE_ORIGIN = 'https://dmarket.com';

class StubWindow extends EventTarget {
  posted: { data: unknown; targetOrigin: string }[] = [];
  postMessage(data: unknown, targetOrigin: string): void {
    this.posted.push({ data, targetOrigin });
  }
}

// Inferred through a helper: spelling vi.spyOn's generics for the runtime namespace fights the WebExtension
// typings for nothing — the mock's shape is all the tests use.
//
// It has to spy through a NARROWED VIEW of the property, not the namespace itself. `runtime.sendMessage` is a
// six-overload chrome-types function whose last overload is `(extensionId, message, options, callback) =>
// void`, and that is the one `vi.spyOn` resolves — so an un-narrowed spy types the mock as returning `void`
// and every `mockResolvedValue(PONG)` below becomes an error. One cast at this seam beats one per call site.
// Same object, same property, only the static type is narrowed. (`@webext-core/fake-browser` v2, which WXT
// 0.21 pulls in, re-types the runtime namespace from `@types/chrome`; v1's promise-only generic defaulted its
// response type to `any`, which is why this needed nothing before.)
//
// The resolved value is `unknown`, not `BridgeResponse`, on purpose: `ackFor` below feeds the bridge reply
// shapes that are deliberately NOT valid responses, because validating an untrusted SW payload is part of
// what these tests cover. Typing it as `BridgeResponse` would reject exactly those fixtures.
type SendMessageHost = { sendMessage(message: unknown): Promise<unknown> };
const spyOnSendMessage = () => vi.spyOn(fakeBrowser.runtime as unknown as SendMessageHost, 'sendMessage');

let win: StubWindow;
let sendMessage: ReturnType<typeof spyOnSendMessage>;
let uninstall: (() => void) | undefined;

beforeEach(() => {
  win = new StubWindow();
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { origin: PAGE_ORIGIN });
  sendMessage = spyOnSendMessage();
  uninstall = undefined;
});

afterEach(() => {
  uninstall?.();
});

/**
 * Deliver a `message` event the way the page's own postMessage would arrive: same-window source unless a
 * fixture overrides it. A plain Event with the MessageEvent fields defined on top, because node's real
 * MessageEvent constructor type-checks `source` against MessagePort.
 */
async function deliver(data: unknown, { origin = PAGE_ORIGIN, source = win }: { origin?: string; source?: unknown } = {}): Promise<void> {
  const event = new Event('message');
  Object.defineProperties(event, {
    data: { value: data },
    origin: { value: origin },
    source: { value: source },
  });
  win.dispatchEvent(event);
  // The relay is fire-and-forget (`void sendMessage().then(...)`), so its reply lands a turn later.
  await flushMacrotasks();
}

const presence = (correlation_id = 'c1') => ({
  source: 'dmarket-fe',
  type: 'RequestPresence',
  correlation_id,
  linked_steam_id: '76561198338780301',
});

/** Fire the fake's onMessage listeners the way the SW's tabs.sendMessage would. The fake's `trigger` takes
 *  the listener's FULL argument list, which since fake-browser v2 means (message, sender, sendResponse), and
 *  resolves once every listener has run. The callback is a no-op because the bridge answers over
 *  `window.postMessage` and never touches `sendResponse` (see bridge.ts). */
const triggerRuntimeMessage = (message: unknown): Promise<unknown> =>
  fakeBrowser.runtime.onMessage.trigger(message, {}, () => {});

const PONG: BridgeResponse = {
  ok: true,
  kind: 'presence',
  version: '0.1.0',
  mismatch: false,
  isActivated: true,
  isTrackingActive: true,
  blockingReason: 'NONE',
};

describe('inbound validation — what never reaches the service worker', () => {
  it('ignores a foreign origin (no SW call, no reply)', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    await deliver(presence(), { origin: 'https://evil.example' });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(win.posted).toEqual([]);
  });

  it('ignores a cross-window source even from an allowed origin', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    await deliver(presence(), { source: { not: 'this window' } });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('ignores an unknown type and a malformed frame', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    await deliver({ source: 'dmarket-fe', type: 'Whatever', correlation_id: 'c' });
    await deliver({ source: 'dmarket-ext', type: 'pong' }); // our own reverse tag must not loop back
    await deliver('just a string');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('accepts a listed EXTRA origin (the remote-config allow-list path)', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN, 'https://stage.example']);
    sendMessage.mockResolvedValue(PONG);
    await deliver(presence(), { origin: 'https://stage.example' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('replies', () => {
  it('RequestPresence → pong with the correlation id and all five status fields, to the page origin', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    sendMessage.mockResolvedValue(PONG);
    await deliver(presence('c-42'));

    expect(sendMessage).toHaveBeenCalledWith({ kind: 'presence' });
    expect(win.posted).toEqual([
      {
        data: {
          source: 'dmarket-ext',
          type: 'pong',
          correlation_id: 'c-42',
          present: true,
          version: '0.1.0',
          mismatch: false,
          is_activated: true,
          is_tracking_active: true,
          blocking_reason: 'NONE',
        },
        // Never '*': a reply broadcast to any origin would hand the tracker's status to any embedder.
        targetOrigin: PAGE_ORIGIN,
      },
    ]);
  });

  it('a presence SW error posts NO frame at all — the FE timeout is the "no extension" signal', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    sendMessage.mockResolvedValue({ ok: false, error: 'boom' });
    await deliver(presence());
    expect(win.posted).toEqual([]);
  });

  it('RequestCycle is relayed but gets no reverse frame (fire-and-forget by protocol)', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    sendMessage.mockResolvedValue({ ok: true, kind: 'request-cycle' });
    await deliver({ source: 'dmarket-fe', type: 'RequestCycle', correlation_id: 'c9', deal_id: 'd1' });
    expect(sendMessage).toHaveBeenCalledWith({ kind: 'request-cycle', dealId: 'd1' });
    expect(win.posted).toEqual([]);
  });

  it('an orphaned/absent receiver (sendMessage rejects) produces no reply and no crash', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
    await deliver(presence());
    expect(win.posted).toEqual([]);
  });
});

describe('CreateTrade acks', () => {
  const createTrade = {
    source: 'dmarket-fe',
    type: 'CreateTrade',
    correlation_id: 'ct-1',
    directive_id: 'dir',
    deal_id: 'deal',
    partner_steam_id: '76561198000000002',
    asset_ids: ['1'],
    trade_token: 'tok',
    linked_steam_id: '76561198000000001',
  };

  const ackFor = async (result: unknown): Promise<unknown> => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    sendMessage.mockResolvedValue({ ok: true, kind: 'create-trade', result });
    await deliver(createTrade);
    return win.posted.at(-1)?.data; // .at(-1): two ackFor calls in one test accumulate in `posted`
  };

  it('success statuses ride through without a reason field', async () => {
    expect(await ackFor({ ok: true, status: 'created' })).toEqual({
      source: 'dmarket-ext',
      type: 'ack',
      correlation_id: 'ct-1',
      status: 'created',
    });
  });

  it('a failure carries its coded reason, and OTHER when the layer below sent none', async () => {
    expect(await ackFor({ ok: false, status: 'failed', error: 'x', reason: 'LIMIT_OUTGOING' })).toMatchObject({
      status: 'failed',
      reason: 'LIMIT_OUTGOING',
    });
    uninstall?.();
    expect(await ackFor({ ok: false, status: 'failed', error: 'x' })).toMatchObject({
      status: 'failed',
      reason: 'OTHER',
    });
  });

  it('an unknown status collapses onto failed rather than leaking through', async () => {
    expect(await ackFor({ ok: false, status: 'throttled', error: 'x', reason: 'NETWORK' })).toMatchObject({
      status: 'failed',
      reason: 'NETWORK',
    });
  });

  it('the account-mismatch guard result becomes an account_mismatch frame', async () => {
    expect(await ackFor({ ok: false, status: 'account_mismatch', tokenSteamId: '765x' })).toEqual({
      source: 'dmarket-ext',
      type: 'account_mismatch',
      correlation_id: 'ct-1',
      token_steam_id: '765x',
    });
  });

  it('an SW-level failure still acks failed with a readable reason', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    sendMessage.mockResolvedValue({ ok: false, error: 'tracker down', reason: 'EXT_NOT_READY' });
    await deliver(createTrade);
    expect(win.posted[0]?.data).toMatchObject({ type: 'ack', status: 'failed', reason: 'EXT_NOT_READY' });
  });
});

describe('the SW → page push and the teardown', () => {
  it('relays a push-account-mismatch as an unsolicited account_mismatch frame (no correlation id)', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    await triggerRuntimeMessage({ kind: 'push-account-mismatch', tokenSteamId: '765y' });
    expect(win.posted).toEqual([
      {
        data: { source: 'dmarket-ext', type: 'account_mismatch', token_steam_id: '765y' },
        targetOrigin: PAGE_ORIGIN,
      },
    ]);
  });

  it('ignores runtime messages that are not the push', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    await triggerRuntimeMessage({ kind: 'something-else' });
    expect(win.posted).toEqual([]);
  });

  it('uninstall removes both listeners: a later post and a later push produce nothing', async () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    sendMessage.mockResolvedValue(PONG);
    uninstall();
    uninstall = undefined;
    await deliver(presence());
    expect(sendMessage).not.toHaveBeenCalled();
    // And the runtime listener is really gone: a push after uninstall reaches nothing.
    await triggerRuntimeMessage({ kind: 'push-account-mismatch', tokenSteamId: '765z' });
    expect(win.posted).toEqual([]);
  });

  it('teardown survives an orphaned context (removeListener throwing)', () => {
    uninstall = installDmarketBridge([PAGE_ORIGIN]);
    // On an extension update this teardown runs with browser.runtime already dead — it must not add a
    // console error per open dmarket tab.
    vi.spyOn(fakeBrowser.runtime.onMessage, 'removeListener').mockImplementation(() => {
      throw new Error('Extension context invalidated.');
    });
    expect(() => uninstall!()).not.toThrow();
    uninstall = undefined;
  });
});
