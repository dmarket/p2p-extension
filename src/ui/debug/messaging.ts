// Promisified browser.runtime messaging for the debug page -> service worker.

import type { DebugRequest, DebugResponse, ForceTickResult, RefreshConfigResult } from '@/debug/protocol';

// Every command can answer with the worker's error envelope instead of its own result, so each response is
// that union. Named once each: the type is needed twice — as the return annotation and as sendMessage's
// own type argument — and spelling it out in both places is how the two come to disagree.
type ErrorEnvelope = { ok: false; error: string };
type ForceTickResponse = (ForceTickResult & { error?: string }) | ErrorEnvelope;
type RefreshConfigResponse = RefreshConfigResult | ErrorEnvelope;

/** Send a `debug:*` request to the service worker and await its response. */
export function sendDebug(msg: DebugRequest): Promise<DebugResponse> {
  // The response type is passed as sendMessage's own second type argument, not asserted onto the result.
  // Its signature is `sendMessage<M = any, R = any>(message: M): Promise<R>`, so an `as Promise<T>` merely
  // supplies R through inference — which means the value is only typed for as long as the assertion (or
  // this function's return annotation) survives, and degrades silently to `any` if either is edited away.
  return browser.runtime.sendMessage<DebugRequest, DebugResponse>(msg);
}

/**
 * Force an immediate DMarket heartbeat now via the dev-only `debug:force-tick` message. The SW calls
 * the core's `forceHeartbeat` (bypasses the ttl cadence gate so a heartbeat always POSTs — even during a
 * Steam-account mismatch, which blocks only Steam activity; the one exception is a missing Steam session,
 * where the cycle stops before the heartbeat), then reports the core's raw blocking reason and writes a
 * visible command entry to the session log so the outcome is never silent. Returning the raw reason keeps
 * this in step with the core automatically — a curated union of "interesting" reasons had already drifted
 * into rendering a blocked tick as a green success.
 */
export function forceTick(): Promise<ForceTickResponse> {
  return browser.runtime.sendMessage<DebugRequest, ForceTickResponse>({ type: 'debug:force-tick' });
}

/**
 * Force a Firebase Remote Config fetch now via the dev-only `debug:refresh-config` message, bypassing the
 * 1h client-side refetch throttle — so a just-published `p2p_tracker_config` lands without waiting. The
 * SW reports whether the POST really happened and whether the document changed, and writes a visible
 * command entry. A changed document is applied immediately (the core restarts only if `tracker.*`
 * differs; `web.*` is read at use-time).
 */
export function refreshRemoteConfig(): Promise<RefreshConfigResponse> {
  return browser.runtime.sendMessage<DebugRequest, RefreshConfigResponse>({ type: 'debug:refresh-config' });
}
