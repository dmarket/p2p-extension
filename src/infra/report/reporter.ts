// The reporter's public surface. Core-free, so the popup and both content scripts can import it.
//
// Shape: `reportError` is synchronous and never throws. In the service worker the sink is the outbox
// (which writes to storage first, then POSTs); everywhere else the default sink relays to the worker, so
// there is exactly ONE sender, one scrub point and one consent check.
//
// Everything on the crash path that can be done synchronously is: the recursion guard, the suppression
// list and a per-spawn duplicate check all run in memory before the first `await`. The persistent
// dedup/budget is applied at flush time instead — a boot crash may leave milliseconds before the worker
// dies, and the most valuable report is exactly the one that must not wait on three storage round-trips.

import { describeError, type ReportContext, type Described } from '@/infra/report/describe';

/** What a report looks like on its way to the sink. Serialisable — it crosses `runtime.sendMessage`. */
export interface PendingReport {
  context: ReportContext;
  message: string;
  stack: string | null;
  fingerprint: string;
  /** Client timestamp, ISO 8601 — stamped where the error happened, not where it is sent. */
  timestamp: string;
  /**
   * True when the values originated from a page-controlled input (the dmarket.com bridge). Charged to a
   * separate, much smaller budget so a hostile page cannot exhaust the internal one and blind the reporter.
   */
  fromPage?: boolean;
}

type ReportSink = (report: PendingReport) => void;

const RELAY_KIND = 'report:error';

interface ReportRelayMessage {
  kind: typeof RELAY_KIND;
  report: PendingReport;
}

function isReportRelayMessage(message: unknown): message is ReportRelayMessage {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as { kind?: unknown; report?: unknown };
  return m.kind === RELAY_KIND && typeof m.report === 'object' && m.report !== null;
}

// ---- in-memory guards -------------------------------------------------------------------------------

let context: ReportContext = 'background';

/**
 * Reporter re-entrancy depth, not a boolean: `reportError` returns immediately while all its real work is
 * async, so a boolean flag is already clear by the time a reporter-internal promise rejects — and that
 * rejection lands on the same global `unhandledrejection` hook, which would call back in. Incremented
 * around every entry and every async continuation the sink owns.
 */
let depth = 0;

/** Fingerprints already reported in THIS worker/page lifetime. Cheap, synchronous first line of defence. */
const seenThisSpawn = new Map<string, number>();

/**
 * Per-context cap for one worker spawn / page load. The persistent budget is authoritative, but a content
 * script has no cheap access to it and every relayed report WAKES the service worker — so a Steam DOM
 * change breaking `createShadowRootUi` on every page load must be bounded here, before `sendMessage`.
 */
const MAX_PER_SPAWN = 8;
let sentThisSpawn = 0;

/**
 * Substrings and patterns never worth reporting. Deliberately short: grown from what the collector actually
 * shows, the way the FE's list was (each of its entries names an observed cause). Everything here is either
 * unactionable or already surfaced as first-class state.
 */
const SUPPRESS: readonly (string | RegExp)[] = [
  // The core aborts every request it times out or cancels; a teardown is not a crash.
  'AbortError',
  'The user aborted a request',
  // Offline / DNS / CORS. The core already debounces this into its DM_CONNECTION_ERROR state, which the popup
  // renders — reporting it too would file a crash for every user who closes their laptop lid.
  'Failed to fetch',
  'NetworkError',
  'Load failed',
  'net::ERR_',
  // Storage pressure: actionable only as a quota problem, and it is the one failure the reporter's own
  // writes can cause, so reporting it risks a loop the depth guard would then have to absorb.
  'QuotaExceededError',
  'exceeded the quota',
  // A bare DOM Event stringified — no information at all.
  /^\{"isTrusted":(true|false)}$/,
];

function isSuppressed(message: string): boolean {
  return SUPPRESS.some((rule) => (typeof rule === 'string' ? message.includes(rule) : rule.test(message)));
}

// ---- sink -------------------------------------------------------------------------------------------

/** Relay to the service worker. The default outside the worker; best-effort by design. */
const relaySink: ReportSink = (report) => {
  try {
    // A torn-down content script has no runtime id; sending would throw "Extension context invalidated".
    if (!browser.runtime?.id) return;
    void browser.runtime.sendMessage({ kind: RELAY_KIND, report } satisfies ReportRelayMessage).catch(() => {
      /* worker starting, or no receiver — the report is dropped, deliberately: retrying from a page that
         is about to be destroyed buys nothing, and the worker's own errors do not come through here. */
    });
  } catch {
    /* never let reporting throw into the caller */
  }
};

let sink: ReportSink = relaySink;

/** Service-worker only: send locally (the outbox) instead of relaying. */
export function setReportSink(fn: ReportSink): void {
  sink = fn;
}

// ---- public API -------------------------------------------------------------------------------------

/**
 * Report a thrown value. Synchronous, never throws, and safe to call from inside a core callback (which
 * runs on a coroutine — a throw there would abort the tracker's cycle).
 *
 * @param options.fromPage the input that led here came from the web page (see {@link PendingReport}).
 * @param options.fromCore the failure came out of the tracker core even if its stack does not say so.
 */
export function reportError(
  error: unknown,
  options: { fromPage?: boolean; fromCore?: boolean } = {},
): void {
  if (depth > 0) return; // a reporter-internal failure must not re-enter
  depth += 1;
  try {
    if (sentThisSpawn >= MAX_PER_SPAWN) return;
    const described: Described = describeError(error, context, options.fromCore ?? false);
    if (isSuppressed(described.message)) return;
    if (seenThisSpawn.has(described.fingerprint)) return;
    seenThisSpawn.set(described.fingerprint, Date.now());
    sentThisSpawn += 1;
    sink({
      context,
      message: described.message,
      stack: described.stack,
      fingerprint: described.fingerprint,
      timestamp: new Date().toISOString(),
      ...(options.fromPage === true ? { fromPage: true } : {}),
    });
  } catch {
    /* reporting must never surface into the caller */
  } finally {
    depth -= 1;
  }
}

/**
 * Install the global hooks for this context. Called from a side-effect module imported FIRST in each
 * entrypoint, so the handlers exist before the heavy imports below them evaluate.
 *
 * `self` is the right target in every context: the service worker has no `window`, and on a page `self`
 * IS `window`. Content scripts deliberately do not call this — Chrome world-tags error events so a content
 * script would not see host-page errors anyway, and the only production-silent path there is WXT's own
 * wrapper, which the entrypoint covers with a try/catch around `main(ctx)`.
 */
export function installGlobalHandlers(ctx: ReportContext): void {
  context = ctx;
  try {
    // No `as ErrorEvent` / `as PromiseRejectionEvent`: the event-map types already give each listener
    // its specific event, so the casts asserted what the compiler had already established.
    self.addEventListener('error', (event) => {
      reportError(event.error ?? event.message ?? 'Unknown error');
    });
    self.addEventListener('unhandledrejection', (event) => {
      reportError(event.reason);
    });
  } catch {
    /* an exotic global with no addEventListener — nothing to install */
  }
}

/** Set this context's tag without installing global hooks (content scripts). */
export function setReportContext(ctx: ReportContext): void {
  context = ctx;
}

/**
 * Service-worker only: accept relayed reports.
 *
 * MUST be a plain, non-`async` listener that returns `undefined` for anything it does not own. WXT's
 * `browser` is the raw native API, and on Firefox an `async` listener returns a promise for EVERY message
 * — including the page bridge's `{kind:'presence'}` — which can be taken as that message's response and
 * make dmarket.com conclude no extension is installed.
 */
export function registerReportRelay(): void {
  browser.runtime.onMessage.addListener((message) => {
    if (!isReportRelayMessage(message)) return undefined;
    // Called straight, not wrapped in a detached async IIFE: `ReportSink` returns void by type (the SW's
    // is `enqueue`, which is itself fire-and-forget internally), so there was never a promise here to
    // detach — only a microtask hop and a comment claiming otherwise. What the listener must not do is
    // RETURN a promise, and the explicit `undefined` below is what guarantees that.
    try {
      sink(message.report);
    } catch {
      /* a relay failure must not become a second report — see the recursion note above */
    }
    return undefined;
  });
}
