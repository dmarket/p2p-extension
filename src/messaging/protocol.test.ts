import { describe, expect, it } from 'vitest';
import { isAccountMismatchPush, isBridgeRequest, isFrontendMessage } from '@/messaging/protocol';

// These three guards are the extension's trust boundary: `isFrontendMessage` narrows an untrusted
// window.postMessage payload from a page, the other two narrow runtime messages. Anything they let
// through reaches the service worker.

// Spelled out rather than imported from the module under test (it is module-private anyway): this tag
// is a wire contract with the DMarket frontend, so the literal is the thing worth pinning — reusing the
// constant would let a change to its VALUE pass every assertion here.
const FE_SOURCE = 'dmarket-fe';

const presence = {
  source: FE_SOURCE,
  type: 'RequestPresence',
  correlation_id: 'c1',
  linked_steam_id: '76561198338780301',
};

describe('isFrontendMessage', () => {
  it('accepts each well-formed frame', () => {
    expect(isFrontendMessage(presence)).toBe(true);
    expect(isFrontendMessage({ source: FE_SOURCE, type: 'RequestCycle', correlation_id: 'c2' })).toBe(true);
    expect(
      isFrontendMessage({ source: FE_SOURCE, type: 'RequestCycle', correlation_id: 'c2', deal_id: 'd1' }),
    ).toBe(true);
    expect(
      isFrontendMessage({
        source: FE_SOURCE,
        type: 'CreateTrade',
        correlation_id: 'c3',
        directive_id: 'dir',
        deal_id: 'deal',
        partner_steam_id: '76561198338780302',
        asset_ids: ['1', '2'],
        trade_token: 'tok',
        linked_steam_id: '76561198338780301',
      }),
    ).toBe(true);
  });

  it('rejects a foreign or missing source', () => {
    expect(isFrontendMessage({ ...presence, source: 'dmarket-ext' })).toBe(false);
    expect(isFrontendMessage({ ...presence, source: undefined })).toBe(false);
  });

  it('rejects an unknown type', () => {
    expect(isFrontendMessage({ ...presence, type: 'Whatever' })).toBe(false);
  });

  it('rejects a frame with no correlation id — every inbound frame carries one', () => {
    expect(isFrontendMessage({ ...presence, correlation_id: undefined })).toBe(false);
    expect(isFrontendMessage({ ...presence, correlation_id: 1 })).toBe(false);
  });

  it('rejects a CreateTrade whose asset_ids is not an array of strings', () => {
    const base = {
      source: FE_SOURCE,
      type: 'CreateTrade',
      correlation_id: 'c3',
      directive_id: 'dir',
      deal_id: 'deal',
      partner_steam_id: '765',
      trade_token: 'tok',
      linked_steam_id: '766',
    };
    expect(isFrontendMessage({ ...base, asset_ids: '1' })).toBe(false);
    expect(isFrontendMessage({ ...base, asset_ids: [1] })).toBe(false);
    expect(isFrontendMessage({ ...base, asset_ids: [null] })).toBe(false);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'string', 42, []]) {
      expect(isFrontendMessage(bad)).toBe(false);
    }
  });
});

describe('isBridgeRequest', () => {
  it('accepts the three known kinds and nothing else', () => {
    expect(isBridgeRequest({ kind: 'presence' })).toBe(true);
    expect(isBridgeRequest({ kind: 'create-trade' })).toBe(true);
    expect(isBridgeRequest({ kind: 'request-cycle' })).toBe(true);
    expect(isBridgeRequest({ kind: 'debug:describe' })).toBe(false);
    expect(isBridgeRequest({})).toBe(false);
    expect(isBridgeRequest(null)).toBe(false);
  });
});

describe('isAccountMismatchPush', () => {
  it('requires the kind and a string steam id', () => {
    expect(isAccountMismatchPush({ kind: 'push-account-mismatch', tokenSteamId: '765' })).toBe(true);
    expect(isAccountMismatchPush({ kind: 'push-account-mismatch' })).toBe(false);
    expect(isAccountMismatchPush({ kind: 'push-account-mismatch', tokenSteamId: 765 })).toBe(false);
    expect(isAccountMismatchPush({ kind: 'presence', tokenSteamId: '765' })).toBe(false);
  });
});
