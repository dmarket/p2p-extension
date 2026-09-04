import {
  EXT_SOURCE,
  type CreateTradeFailureReason,
  isAccountMismatchPush,
  isCreateTradeFailureReason,
  isFrontendMessage,
  type BridgeRequest,
  type BridgeResponse,
  type ExtensionMessage,
  type FrontendMessage,
} from './protocol';
import { DMARKET_ORIGINS } from '@/config/settings';

// Origins allowed to talk to the bridge, in addition to the page's own origin. The content script
// only runs on manifest-matched (trusted) hosts, so a same-window self-post from the page's own
// origin is always accepted; this list admits any additional cross-window origins. The default is the
// two dmarket origins (DMARKET_ORIGINS — the single home of that pair); the content entrypoint passes
// a resolved list that also merges remote-config extras (and, in debug builds, dev FE origins), so
// this is a configurable allow-list, never a single hardcoded origin.

function toBridgeRequest(message: FrontendMessage): BridgeRequest {
  switch (message.type) {
    case 'RequestPresence':
      return { kind: 'presence' };
    case 'CreateTrade':
      return {
        kind: 'create-trade',
        directiveId: message.directive_id,
        dealId: message.deal_id,
        partnerSteamId: message.partner_steam_id,
        assetIds: message.asset_ids,
        tradeToken: message.trade_token,
        linkedSteamId: message.linked_steam_id,
      };
    case 'RequestCycle':
      return { kind: 'request-cycle', dealId: message.deal_id };
  }
}

/**
 * The coded cause carried by any create-trade failure shape, defaulting to the tolerant `OTHER`.
 * Takes the whole union (core result or SW envelope) and reads the one optional field off it, so a
 * caller never has to narrow first — and a shape that never carries a reason still answers `OTHER`.
 */
function failureReason(source: object): CreateTradeFailureReason {
  const reason = (source as { reason?: unknown }).reason;

  return isCreateTradeFailureReason(reason) ? reason : 'OTHER';
}

/**
 * Build the trimmed `dmarket-ext` reply for an inbound frame. `RequestPresence` → `pong`;
 * `CreateTrade` → `ack` (proceeded) or `account_mismatch` (blocked by the guard). `RequestCycle` is a
 * plain nudge with **no** reverse frame in this protocol, so it returns `null`.
 */
function toReply(message: FrontendMessage, response: BridgeResponse): ExtensionMessage | null {
  const correlation_id = message.correlation_id;

  if (message.type === 'RequestPresence') {
    if (response.ok && response.kind === 'presence') {
      return {
        source: EXT_SOURCE,
        type: 'pong',
        correlation_id,
        present: true,
        version: response.version,
        mismatch: response.mismatch,
        is_activated: response.isActivated,
        is_tracking_active: response.isTrackingActive,
        blocking_reason: response.blockingReason,
      };
    }
    // SW error: send nothing — the FE's presence timeout then treats it as no extension.
    return null;
  }

  if (message.type === 'CreateTrade') {
    if (response.ok && response.kind === 'create-trade') {
      const r = response.result;
      if (!r.ok && 'status' in r && r.status === 'account_mismatch') {
        return { source: EXT_SOURCE, type: 'account_mismatch', correlation_id, token_steam_id: r.tokenSteamId };
      }
      const status =
        'status' in r && (r.status === 'needs_confirmation' || r.status === 'created' || r.status === 'failed')
          ? r.status
          : 'failed';
      // A failed ack names its cause. `reason` rides through from whichever layer knew it — the
      // create-trade seam, which maps the core's coded cause (src/core/createTradeOutcome.ts), or the
      // SW's own guard. It is never inferred HERE: this runs in the page's content script, and the
      // core's free-form `error` text does not reach it. `status` collapses the seam's `throttled` and
      // `create_in_flight` onto `failed` below — the page's vocabulary has three statuses, and what
      // those two carry beyond "it did not happen" is already in `reason`.
      return status === 'failed'
        ? { source: EXT_SOURCE, type: 'ack', correlation_id, status, reason: failureReason(r) }
        : { source: EXT_SOURCE, type: 'ack', correlation_id, status };
    }
    return { source: EXT_SOURCE, type: 'ack', correlation_id, status: 'failed', reason: failureReason(response) };
  }

  // RequestCycle: fire-and-forget nudge, no reverse frame.
  return null;
}

/**
 * Install the page bridge on dmarket.com: validate inbound `dmarket-fe` frames and relay them to the
 * service worker, posting the trimmed `dmarket-ext` reply back to the page; and relay SW-initiated
 * account-mismatch pushes to the page as unsolicited `account_mismatch` frames. Returns an uninstall
 * function. All reverse frames are posted to `location.origin` (never `"*"`).
 */
export function installDmarketBridge(allowedOrigins: string[] = DMARKET_ORIGINS): () => void {
  const onPageMessage = (event: MessageEvent): void => {
    // The page is untrusted: accept only messages this same window posted, from an allowed origin,
    // tagged and well-formed by the frontend.
    if (event.source !== window) return;
    if (event.origin !== location.origin && !allowedOrigins.includes(event.origin)) return;
    if (!isFrontendMessage(event.data)) return;

    // If the extension was reloaded, this injected content script is orphaned and browser.runtime is
    // dead — reloading the tab re-injects a fresh one.
    if (!browser.runtime?.id) return;

    const message = event.data;

    // An orphaned context or a missing receiver rejects the promise — swallow it.
    void browser.runtime
      .sendMessage(toBridgeRequest(message))
      .then((response?: BridgeResponse) => {
        if (!response) return;
        const reply = toReply(message, response);
        if (reply) window.postMessage(reply, location.origin);
      })
      .catch(() => {});
  };

  // SW -> page push: a heartbeat detected a wrong account. Emit an unsolicited `account_mismatch`
  // (no correlation_id) so the FE shows the "log into the correct Steam account" banner.
  const onRuntimeMessage = (message: unknown): void => {
    if (!isAccountMismatchPush(message)) return;
    const frame: ExtensionMessage = { source: EXT_SOURCE, type: 'account_mismatch', token_steam_id: message.tokenSteamId };
    window.postMessage(frame, location.origin);
  };

  window.addEventListener('message', onPageMessage);
  browser.runtime.onMessage.addListener(onRuntimeMessage);
  return () => {
    window.removeEventListener('message', onPageMessage);
    // Guarded, and the page listener above goes first: this teardown also runs in an ORPHANED context —
    // on an extension update, the newly injected bridge invalidates this one (see the WXT note in
    // entrypoints/dmarket-bridge.content.ts) at a point where `browser.runtime` is already dead. The
    // listener that could double-answer is gone either way; a throw here would only add a console error
    // per open dmarket tab on every update.
    try {
      browser.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      /* orphaned context — the extension went away and took its listener with it */
    }
  };
}
