// FIRST import, deliberately: it installs the global error/unhandledrejection hooks at module-evaluation
// time, so they exist before the ~1.2 MB compiled core below evaluates. A top-level throw in the core's
// module body is otherwise unreported — WXT's background wrapper logs it and rethrows, and its logger is
// compiled out of production.
import '@/infra/report/install';
import { Tracker, type BlockingReason, type TrackerHandle } from '@/core/tracker';
import { installSteamAntiCsrf } from '@/background/anti-csrf';
import { installDevSteamRedirect } from '@/background/dev-steam-redirect';
import { registerBridgeRouter } from '@/background/router';
import { registerContentScriptInjection } from '@/background/inject-content-scripts';
import { reconcileSteamSession, registerRefreshTriggers } from '@/background/refresh';
import type { AccountMismatchPush } from '@/messaging/protocol';
import { initIcon } from '@/background/icon';
import { setBlockingReason, setLinkedSteamId } from '@/state/blocking';
import { setActiveTrackingCount } from '@/state/activeCount';
import { registerReportRelay, reportError, setReportSink } from '@/infra/report/reporter';
import { enqueue, flush } from '@/infra/report/outbox';
import { isRemoteConfigEnabled } from '@/infra/config';
import { fetchRemoteConfig, hasFetchedRemoteConfig } from '@/infra/remoteConfig';
import { resolveNotaryUrl } from '@/config/notaryUrl';
import {
  DMARKET_ORIGINS,
  getSettings,
  loadSettings,
  subscribeSettings,
  type TrackerOverrides,
} from '@/config/settings';

// The core talks to two endpoints: the DMarket API (base URL) and the FE origin the marketplace
// token is read from. Debug builds default to the Dev environment when it is configured in the
// gitignored .env (WXT_DEV_* — see .env.example; the repository carries no internal hostnames);
// production builds — and debug builds without a .env — default to Prod. `import.meta.env.DEV` is a
// compile-time constant, so the Dev branch is dead-code-eliminated from production bundles.
// Overridable via env (and, in debug builds, at runtime from the debug console).
const DEFAULT_API_BASE_URL = import.meta.env.DEV
  ? import.meta.env.WXT_DEV_API_URL || 'https://api.dmarket.com'
  : 'https://api.dmarket.com';
const DEFAULT_FE_URL = import.meta.env.DEV
  ? import.meta.env.WXT_DEV_FE_URL || 'https://dmarket.com/'
  : 'https://dmarket.com/';

/** How long after boot to drain the crash-report outbox — clear of the boot cycle's Steam work. */
const REPORT_FLUSH_DELAY_MS = 5_000;

/**
 * How long a FIRST install may wait for its remote-config document before starting the core anyway.
 * Sized to cover a normal round trip to Firebase and no more: overrunning it costs only the old
 * boot-then-restart, whereas a longer wait would delay the first heartbeat of a fresh install.
 */
const FIRST_CONFIG_FETCH_BUDGET_MS = 3_000;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export default defineBackground(() => {
  // FIRST, when a local Steam stand-in is configured (WXT_DEV_STEAM_URL): the core's boot cycle below can
  // reach Steam on its first heartbeat, and the redirect has to be in place by then. A no-op in
  // production (compile-time-gated, tree-shaken) and in debug builds without that variable.
  installDevSteamRedirect();

  // The service worker is the only sender: page contexts relay here. Registered synchronously, BEFORE the
  // bootCore() await below, so a relayed report can wake a dormant worker and still be handled.
  setReportSink(enqueue);
  registerReportRelay();

  // Reflect onboarding + Steam-account state on the toolbar icon (green when activated & matched,
  // pink/red otherwise). Registered synchronously so it re-attaches on every worker spawn.
  initIcon();

  // The MV3 service worker is killable and respawned on events, so everything the core relies on
  // must be registered synchronously at top level on every spawn (the core re-attaches its own
  // chrome.alarms listener from inside startTracker).
  const defaultApiUrl = import.meta.env.WXT_DMARKET_API_BASE_URL || DEFAULT_API_BASE_URL;
  const defaultFeUrl = import.meta.env.WXT_DMARKET_FE_URL || DEFAULT_FE_URL;

  let handle: TrackerHandle | undefined;
  let currentApiUrl = defaultApiUrl;
  let currentFeUrl = defaultFeUrl;
  // The remote-config core overrides currently applied to the running tracker (empty = core defaults).
  // Read by startWith on every (re)start, so a debug endpoint switch preserves them. Reconciled after
  // boot and whenever the Remote Config cache changes (see the settings subscription below).
  let currentOverrides: TrackerOverrides = {};
  // Dev-only notary WebSocket from the debug console, THREE-state: `undefined` = the console has never
  // spoken, `null` = the operator cleared it, a string = the operator set it. Why three, and the precedence
  // it feeds, are `resolveNotaryUrl`'s to document (src/config/notaryUrl.ts) — including the two ordering
  // regressions behind it. Kept OUT of `currentOverrides` and merged only at start (like `feUrl`), because
  // that variable is replaced wholesale whenever Remote Config publishes: folding it in would let an
  // unrelated publish silently drop the operator's override mid-session.
  let debugNotaryUrl: string | null | undefined;
  // Dev-only blocking-state simulation, from the debug console (src/debug/simulate.ts resolves which
  // config makes which state real; this side only holds and merges the result). Kept out of
  // `currentOverrides` for the same reason as the notary URL.
  let debugSimulation: TrackerOverrides | null = null;
  // Dev-only: the simulated reason the surfaces must render, or `null`/absent for "mirror the core". An
  // injected getter rather than an import, like every other hook into src/debug/ (setLifecycleSink,
  // setNotaryTraceSink), because that tree does not exist in production builds.
  let blockingReasonOverride: (() => BlockingReason | null) | undefined;
  // Unsubscribe for the active-tracking-count mirror; bound to the current handle, so it must be torn
  // down and re-bound whenever the handle is replaced (endpoint restart).
  let unsubscribeActiveCount: (() => void) | undefined;

  // Register the dmarket.com bridge router synchronously (reads the handle lazily).
  registerBridgeRouter(() => handle);

  // Re-inject the content scripts into tabs that were already open when this extension was installed or
  // updated — those tabs get no declarative injection at all, so the dmarket FE keeps timing out on
  // presence (and keeps showing "install the extension" over a working install) and the Steam onboarding
  // banner, the thing the user activates from, never appears. Registered synchronously: `onInstalled`
  // fires exactly once and must be able to wake a worker that isn't running yet.
  registerContentScriptInjection();

  // Register the host-only re-evaluation triggers: a change to either session cookie (`dm-trade-token`
  // or Steam's) nudges the core to re-check that session now (forceHeartbeat marks the heartbeat due, so
  // the cycle re-reads both), so a login/logout surfaces immediately — the reactive signal the core can't
  // observe itself — instead of waiting for the next scheduled heartbeat. The core still owns the reason;
  // we only wake it. (The matching post-boot Steam reconcile runs in bootCore.)
  registerRefreshTriggers(
    () => handle,
    // Re-read the reason after the nudged cycle: the cycle that establishes a block may emit no event that
    // carries it, so a sign-out would otherwise stay invisible until the next tick (see mirrorBlockingState).
    (h) => mirrorBlockingState(h),
  );

  // Match patterns for the dmarket tabs a reverse frame can be pushed to. Production: the two dmarket
  // origins. Debug builds also push to the dev FE origins the debug console configured
  // (`debug.allowedOrigins`); the whole dev branch is a compile-time constant, tree-shaken from prod.
  const PROD_TAB_PATTERNS = DMARKET_ORIGINS.map((o) => `${o}/*`);
  const dmarketTabPatterns = async (): Promise<string[]> => {
    const extra: string[] = [];
    // Remote-config extra bridge origins (all builds). NB: with no `tabs` permission in the manifest the
    // `url` filter below is honoured only for tabs we hold host permission for, so an origin outside
    // `host_permissions` matches nothing. Harmless, and not a loss either: no bridge is ever injected
    // into such an origin declaratively, so that tab has no listener for this push in the first place.
    for (const o of getSettings().web.bridgeExtraOrigins) extra.push(`${o.replace(/\/+$/, '')}/*`);
    // Dev builds also honour the debug console's recorded origins (compile-time-gated, tree-shaken from prod).
    if (import.meta.env.DEV) {
      try {
        const stored = (await browser.storage.local.get('debug.allowedOrigins'))['debug.allowedOrigins'];
        if (Array.isArray(stored)) for (const o of stored) if (typeof o === 'string') extra.push(`${o.replace(/\/+$/, '')}/*`);
      } catch {
        /* ignore */
      }
    }
    return [...PROD_TAB_PATTERNS, ...extra];
  };

  // Push an unsolicited `account_mismatch` to every dmarket tab: the content script relays it to the
  // page. Best-effort — tabs without our content script (or closed mid-send) just reject.
  const pushAccountMismatch = async (tokenSteamId: string): Promise<void> => {
    try {
      const tabs = await browser.tabs.query({ url: await dmarketTabPatterns() });
      // Ids first, so the map below is one promise per tab rather than an array of arrays padded with
      // non-thenables (which is what `Promise.all` was being handed).
      const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
      await Promise.all(
        ids.map((id) =>
          browser.tabs
            .sendMessage(id, { kind: 'push-account-mismatch', tokenSteamId } satisfies AccountMismatchPush)
            .catch(() => {}),
        ),
      );
    } catch {
      /* no matching tabs / query failed */
    }
  };

  // The core events that mark a settled state worth re-reading `blockingReason()` at (per the core's
  // FE-interaction contract). Only these poke the UI — the core emits other event types too, and
  // reacting to all of them just does redundant storage work. CycleStarted is included as a
  // self-healing backstop: the transition events are entry-only, so if one is ever missed (or the
  // stored value is edited externally, e.g. via the debug console), the every-cycle poke re-converges
  // the mirror to the core's live state within one wake.
  const BLOCKING_EVENTS = new Set([
    'CycleStarted',
    'ReLoginNeeded',
    'MarketplaceServerError',
    'LinkedSteamIdMismatch',
    'HeartbeatSent',
    'CycleCompleted',
  ]);

  /**
   * Mirror the core's resolved blocking reason into the persisted state every surface reads. The popup, the
   * Steam on-page banner AND the toolbar icon all subscribe to this one key (state/blocking.ts), so a single
   * write updates every surface. `setBlockingReason` is read-compare-write, so an unchanged reason writes
   * nothing (no onChanged → no re-render, no icon churn), and there is deliberately NO in-memory dedupe on
   * top of it: an externally rewritten stored value must be corrected, not pinned by a stale copy.
   *
   * Called from two places, and the second one is not redundant — it is the fix for a real gap:
   *   1. the core's own lifecycle events (the settled ones in BLOCKING_EVENTS), and
   *   2. after a HOST-INITIATED forced heartbeat resolves.
   *
   * (2) exists because the core's events cannot carry every transition. `CycleStarted` is emitted at the top
   * of a cycle (TradeTrackerLoop.kt:943), i.e. BEFORE that cycle establishes anything; the Steam credential
   * gate then sets the missing-session flag and returns (:1021-1023) WITHOUT emitting anything at all unless
   * the provider also reported a failed re-login — and a short-circuited cycle emits no `CycleCompleted`
   * either. So the cycle that first establishes a block can end with the mirror still holding the previous
   * value, and the surfaces only catch up on the NEXT cycle, which is an alarm tick (or a whole backend ttl)
   * away. Reading once more after the cycle we asked for has settled is the same discipline the debug
   * console's force tick already uses for its own log line.
   */
  const mirrorBlockingState = (h: TrackerHandle): void => {
    try {
      // Dev-only: while a blocking-state simulation is armed the switcher is authoritative, because a
      // simulated CAUSE can only ever add a block — a real higher-ranked one would hide it, and no cause can
      // assert a state is absent (see simulatedReason). `undefined` in production, and `null` whenever the
      // master switch is off, so the truthful path is the default.
      const reason = blockingReasonOverride?.() ?? Tracker.blockingReason(h);
      void setBlockingReason(reason);
      // The linked id is only meaningful while the wrong-account prompt is the one being shown, so it is
      // dropped with the prompt. A mismatch that is merely outranked (e.g. the DMarket connection went
      // down first) drops it too and re-learns it from the next mismatched heartbeat — the alternative,
      // keeping it around, risks showing a months-old account id next to a fresh prompt.
      if (reason !== 'STEAM_ACCOUNT_MISMATCH') void setLinkedSteamId(undefined);
    } catch (error) {
      // Handle not ready — the last known state stands. Worth reporting though: if blockingReason() keeps
      // throwing, the UI mirror silently freezes on a stale verdict, which is a bug class this project has
      // already hit three times and which is invisible from the outside.
      try {
        reportError(error, { fromCore: true });
      } catch {
        /* never break the core's cycle */
      }
    }
  };

  // Secret-free lifecycle events from the core. A relevant event is just a poke to re-read the single
  // source of truth — `blockingReason()` — and mirror it into the persisted state the UI subscribes to;
  // the client never derives priority itself. A heartbeat-detected wrong account additionally drives the
  // unsolicited FE `account_mismatch` push (a separate channel from the extension's own banners; only
  // that event carries the wrong Steam id). Never carries a credential.
  // NOTE: every reportError call in this function is inside its own try/catch, because this callback and
  // the onCount one below run SYNCHRONOUSLY inside the core's coroutines — a throw here would abort the
  // tracker's cycle. (reportError is already no-throw by contract; the guards are belt and braces.)
  // Dev-only sink for the raw event frames (the debug console's session log). Unset in production, where
  // `src/debug/*` is not even bundled — see the installDebug block below.
  let lifecycleSink: ((json: string) => void) | undefined;

  const onLifecycleEvent = (json: string): void => {
    // First, verbatim to the debug log (when one is listening): the frames that explain a cycle which sent
    // nothing are precisely the ones no network capture can show. Guarded like every other call in this
    // callback — it runs synchronously inside the core's coroutine, where a throw aborts the cycle.
    try {
      lifecycleSink?.(json);
    } catch {
      /* never break the core's cycle */
    }
    let parsed: { event?: unknown; tokenSteamId?: unknown; linkedSteamId?: unknown };
    try {
      parsed = JSON.parse(json) as typeof parsed;
    } catch {
      // The core↔host wire contract broke. Report the SHAPE only — never the JSON itself: this stream
      // demonstrably carries a Steam id (LinkedSteamIdMismatch), so echoing an unparseable frame would ship
      // whatever it happens to hold.
      try {
        reportError(new Error(`lifecycle event JSON unparseable (${json.length} chars)`), { fromCore: true });
      } catch {
        /* never break the core's cycle */
      }
      return;
    }
    if (parsed.event === 'LinkedSteamIdMismatch') {
      if (typeof parsed.tokenSteamId === 'string') void pushAccountMismatch(parsed.tokenSteamId);
      // Remember WHICH account the user has to sign into. Only this event carries it, and a popup opened
      // afterwards never sees the event — so without persisting it the prompt can only say "the account
      // linked to DMarket" and the user has no way to tell a stale verdict from a real one. It is their own
      // linked id; the other account's id (`tokenSteamId`) is pushed to the FE but never stored or shown.
      if (typeof parsed.linkedSteamId === 'string') void setLinkedSteamId(parsed.linkedSteamId);
    }
    // Re-read the core's resolved blocking reason on the settled events and persist it.
    if (typeof parsed.event === 'string' && BLOCKING_EVENTS.has(parsed.event) && handle !== undefined) {
      mirrorBlockingState(handle);
    }
  };

  // The published overrides, with the debug notary URL layered on top when one is set. One field, because
  // the core's gate is now one field: `notaryUrl` (plus a delegate, which only Chrome supplies). The
  // redundant `enabled` flag it used to also set is gone from the core — the backend's per-deal
  // `proof_required` decides whether a deal needs a proof; this decides only whether we can make one.
  // The dev-only simulation is layered the same way, and per GROUP rather than wholesale: a published
  // `marketplaceScrape.tokenRefreshPath` must survive a simulated missing session, and vice versa.
  const trackerOverrides = (): TrackerOverrides => {
    let o = currentOverrides;
    // Notary URL: console > published > build default, resolved by `resolveNotaryUrl` (src/config —
    // where the table lives, and where it is tested; two ordering regressions have been fixed in it).
    // Assigned only on a real change, so the common case — a publish already naming the notary — allocates
    // nothing.
    const notaryUrl = resolveNotaryUrl(o.notary?.notaryUrl, debugNotaryUrl);
    if (notaryUrl !== o.notary?.notaryUrl) o = { ...o, notary: { ...o.notary, notaryUrl } };
    // Dev-only fixture CA for the proven read's TLS chain, from a build-time variable rather than remote
    // config: it is a trust anchor, and a published one plus control of the byte pipe would let the prover
    // accept a forged api.steampowered.com and attest it. `import.meta.env.DEV` is a compile-time constant,
    // so production drops this branch and the variable with it. Absent (the default, and always in prod)
    // leaves the prover on its bundled Mozilla roots — the core writes no `rootStore` key at all.
    if (import.meta.env.DEV && import.meta.env.WXT_DEV_NOTARY_ROOT_PEM) {
      o = { ...o, notary: { ...o.notary, rootStorePem: import.meta.env.WXT_DEV_NOTARY_ROOT_PEM } };
    }
    if (debugSimulation !== null) {
      o = { ...o };
      if (debugSimulation.marketplaceScrape) {
        o.marketplaceScrape = { ...o.marketplaceScrape, ...debugSimulation.marketplaceScrape };
      }
      if (debugSimulation.steamScrape) {
        o.steamScrape = { ...o.steamScrape, ...debugSimulation.steamScrape };
      }
    }
    return o;
  };

  // Boot (or reboot) the self-driving tracker against the API + FE endpoints, tracking the current
  // ones. Returns the freshly started handle (also tracked in `handle`) so callers can act on it
  // directly — TS can't see the closure assignment through the call, so reading `handle` after a
  // startWith() call narrows to a stale `undefined`.
  const startWith = (apiUrl: string, feUrl: string): TrackerHandle => {
    const started = Tracker.start(apiUrl, feUrl, onLifecycleEvent, trackerOverrides());
    handle = started;
    currentApiUrl = apiUrl;
    currentFeUrl = feUrl;
    // Mirror the core's live active-tracking count into session storage so the popup's "Activity on
    // DMarket" badge reflects it across the SW/popup boundary. `onCount` fires immediately with the
    // current value (0 for a fresh handle) and again each cycle; setActiveTrackingCount is
    // read-compare-write, so unchanged counts don't churn onChanged. Re-bound on every spawn/restart.
    // The immediate synchronous echo is SKIPPED: a fresh handle always reports 0 before any heartbeat,
    // and writing it would wipe the session-mirrored real count on every idle respawn (the badge would
    // show 0 for up to a ttl). Real counts — including a genuine 0 — arrive with heartbeats.
    unsubscribeActiveCount?.();
    let initialEcho = true;
    unsubscribeActiveCount = Tracker.subscribeActiveTrackingCount(started, (count) => {
      if (initialEcho) {
        initialEcho = false;
        return;
      }
      void setActiveTrackingCount(count);
    });
    console.info('[dmarket-p2p] tracker core booted', {
      version: Tracker.version(),
      games: Tracker.enabledGameCount(),
      apiUrl,
      feUrl,
    });
    return started;
  };

  // Stop and restart against new endpoints/config. Invoked by the dev-only debug console (endpoint
  // switch) and by a genuine remote-config override change (reconcileOverrides).
  const restartWith = (apiUrl: string, feUrl: string): void => {
    if (handle !== undefined) {
      unsubscribeActiveCount?.();
      unsubscribeActiveCount = undefined;
      try {
        Tracker.stop(handle);
      } catch {
        /* already torn down */
      }
      handle = undefined;
    }
    try {
      const restarted = startWith(apiUrl, feUrl);
      // An explicit restart should take effect NOW: the fresh instance restores the persisted
      // heartbeat schedule and would otherwise idle until the OLD schedule's due tick (an endpoint
      // switch would look dead for up to a ttl). One forced heartbeat re-fetches truth against the
      // new endpoints/config immediately — and the mirror is re-read once it has settled, because the
      // cycle that establishes a block may emit no event that carries it (see mirrorBlockingState).
      void Tracker.forceHeartbeat(restarted)
        .then(() => mirrorBlockingState(restarted))
        .catch(() => {
          /* offline / torn down — the due tick re-evaluates */
        });
    } catch (error) {
      console.error('[dmarket-p2p] tracker core failed to restart', error);
      reportError(error, { fromCore: true });
    }
  };

  // Apply the remote-config tracker overrides in place: rebuild the core against `next` only when it
  // actually differs from what's running (a restart re-runs the boot cycle, so it's paid only when
  // overrides are present/changed — a rare hotfix; the no-override path never restarts). The FE/API
  // endpoints are unchanged here, so a debug endpoint switch still wins and preserves these overrides.
  const reconcileOverrides = (next: TrackerOverrides): void => {
    if (JSON.stringify(next) === JSON.stringify(currentOverrides)) return;
    currentOverrides = next;
    if (handle === undefined) return; // boot failed; startWith will pick these up if it ever runs
    console.info('[dmarket-p2p] applying remote-config tracker overrides; restarting core');
    restartWith(currentApiUrl, currentFeUrl);
  };

  // Boot the core exactly ONCE per spawn, with the cached remote-config overrides already resolved — so
  // we never start-with-defaults then immediately restart-with-overrides. That earlier double-start
  // re-ran the heavy core boot cycle on every respawn whenever a tracker override was live, and left an
  // uncaught "Job was cancelled" from stopping a mid-boot cycle. `loadSettings()` never throws (→ `{}`
  // on any failure). The core runs a boot cycle immediately on start (core ≥ .104 it heartbeats only
  // when due — first start, expired schedule, or a forced nudge; a respawn inside a live backend-ttl
  // window idles), so nothing here depends on the alarm listener being registered in this exact tick;
  // the async gap is one fast storage read.
  const bootCore = async (): Promise<void> => {
    // Decided BEFORE the fetch starts, so its own stamp write can never be read as "already fetched".
    const firstFetchEver = isRemoteConfigEnabled() && !(await hasFetchedRemoteConfig());
    // One remote-config refresh per spawn (throttled to 1h inside; a no-op when unconfigured).
    const configFetch = fetchRemoteConfig();
    // FIRST INSTALL ONLY: there is no cached document yet, so starting the core now means starting it on
    // compiled defaults and then having that very fetch restart it — a second full boot cycle plus the
    // forced heartbeat `restartWith` fires, landing in the same window as the install-time content-script
    // re-injection and the first (always-due) heartbeat. That burst is what keeps the popup on its loading
    // state for the first minute or two after an install, since its two storage reads queue behind the
    // core's own. So wait for the document — but briefly, and never at the cost of booting at all: on
    // timeout this falls through to exactly the old behaviour (boot on defaults; the subscription below
    // reconciles when the fetch lands). Every later spawn has the stamp and skips the wait entirely, and
    // the listeners that must be registered synchronously are all above, outside bootCore.
    if (firstFetchEver) {
      await Promise.race([configFetch, delay(FIRST_CONFIG_FETCH_BUDGET_MS)]);
    }
    currentOverrides = (await loadSettings()).tracker;
    // Debug builds: resolve the debug console's stored endpoint overrides BEFORE the first start, so
    // the reconcile in debug/boot.ts finds nothing to change — previously it stop+restarted the
    // just-booted core on every spawn whenever a stored override differed from the build default
    // (leaving an uncaught "Job was cancelled" from the aborted boot cycle). Keys inlined (not imported
    // from @/debug/protocol) so this compile-time-dead branch pulls nothing debug into prod.
    let bootApiUrl = defaultApiUrl;
    let bootFeUrl = defaultFeUrl;
    if (!import.meta.env.PROD) {
      try {
        const stored = await browser.storage.local.get([
          'debug.apiBaseUrl',
          'debug.feUrl',
          'debug.notaryUrl',
          'debug.simulation',
          'debug.demand',
        ]);
        const api = stored['debug.apiBaseUrl'];
        const fe = stored['debug.feUrl'];
        const notary = stored['debug.notaryUrl'];
        if (typeof api === 'string' && api) bootApiUrl = api;
        if (typeof fe === 'string' && fe) bootFeUrl = fe;
        // Resolved BEFORE the first start for the same reason as the endpoints: a notary applied after
        // boot would otherwise need a second stop+restart of a core that just came up. A PRESENT key wins
        // over the build default even when empty — that is how `debug:set-notary` records a clear (it
        // stores ''), so an operator who turns the notary off keeps it off across respawns. An ABSENT key
        // leaves `debugNotaryUrl` undefined, which is what lets a published value (and only then the build
        // default) through — see the precedence in `trackerOverrides()`.
        if (typeof notary === 'string') debugNotaryUrl = notary || null;
        // The blocking-state simulator, before the first start for a second reason as well: this call is
        // what installs its fetch rails, and one of them exists to stop the core's Steam session mint from
        // rotating a real session — which the boot cycle can reach.
        const sim = await import('@/debug/simulate');
        debugSimulation = sim.applySimulation(stored['debug.simulation']);
        blockingReasonOverride = sim.simulatedReason;
        // The freshness-mark injector rides the same fetch wrap `applySimulation` just installed, and it
        // has to be armed before the first heartbeat: the mark it stamps is what a demand is DETECTED
        // from, so an injector resolved after boot would be silently skipped for one whole cycle. Unlike
        // the simulation it contributes no core overrides and no reason override — see demandState.ts.
        sim.applyDemand(stored['debug.demand']);
      } catch {
        /* storage unavailable — keep the build defaults */
      }
    }
    try {
      startWith(bootApiUrl, bootFeUrl);
      // A real change writes the cache → the subscription below fires and reconciles onto the running
      // core (diff-guarded, so an unchanged fetch is a no-op). Already in flight; see above.
      void configFetch;
      // Now that a handle exists (and settings are loaded), settle a possibly-stale "no Steam session"
      // block: if the cookie is back, one nudge re-checks it instead of waiting out the ttl. No-op in
      // every other state.
      void reconcileSteamSession(() => handle);
    } catch (error) {
      // A boot failure must not tear down the worker or the listeners registered above.
      console.error('[dmarket-p2p] tracker core failed to start', error);
      reportError(error, { fromCore: true });
    }
    // Drain anything a previous (possibly crashed) spawn left queued. Deferred a few seconds rather than
    // run inline: this is the contended window — the core's boot cycle, the Steam settoken work and the
    // remote-config fetch all land here — and a backlog of POSTs has no reason to compete with them.
    setTimeout(() => void flush(), REPORT_FLUSH_DELAY_MS);
    // Apply LATER remote-config changes to the running core — rare, only on an actual publish (NOT on
    // every respawn: currentOverrides now reflects exactly what the core was started with).
    subscribeSettings((s) => reconcileOverrides(s.tracker));
  };

  // Dev-only debug console runs AFTER the core is booted (so getHandle() is populated and the debug
  // endpoint-override reconcile can't race a second core start). The dynamic import — and everything
  // under src/debug/ — is a compile-time-guarded dead branch, tree-shaken from production bundles.
  void bootCore().then(() => {
    if (!import.meta.env.PROD) {
      void import('@/debug/boot').then((m) =>
        m.installDebug({
          getHandle: () => handle,
          getEndpoints: () => ({ apiUrl: currentApiUrl, feUrl: currentFeUrl }),
          restart: restartWith,
          // The EFFECTIVE URL, not the debug key: `trackerOverrides()` is the exact object the tracker was
          // started with, so this reports a remote-config notary as well as a debug one. Reading
          // `debugNotaryUrl` alone made the console claim "no-op prover" for a perfectly configured core.
          getNotaryUrl: () => trackerOverrides().notary?.notaryUrl ?? null,
          setNotaryUrl: (url) => {
            debugNotaryUrl = url;
            // The prover is selected once, when the loop is built, so a running core cannot be switched
            // over in place — restarting against the SAME endpoints is what rebuilds it.
            restartWith(currentApiUrl, currentFeUrl);
          },
          setSimulationOverrides: (overrides) => {
            debugSimulation = overrides;
            // Same reason as the notary: the cookie names a simulated session hides are read when the loop
            // is built. The restart's forced heartbeat is also what makes the state appear at once rather
            // than at the next due tick.
            restartWith(currentApiUrl, currentFeUrl);
          },
          refreshBlockingMirror: () => {
            if (handle !== undefined) mirrorBlockingState(handle);
          },
          setLifecycleSink: (sink) => {
            lifecycleSink = sink;
          },
        }),
      );
    }
  });

  // Push delivery is the host's job — the core owns no push transport. Forward the payload into the
  // running tracker to nudge a cycle. ('push' is a service-worker event; type it loosely to avoid
  // pulling in the WebWorker lib alongside the DOM lib. On a Firefox MV3 event page there is no push
  // transport, so this listener is simply never invoked — harmless, no guard needed.)
  self.addEventListener('push', (event) => {
    const pushEvent = event as Event & {
      data?: { text(): string };
      waitUntil(promise: Promise<unknown>): void;
    };
    if (handle === undefined) return;
    const payload = pushEvent.data?.text() ?? '';
    pushEvent.waitUntil(Tracker.deliverPush(handle, payload));
  });

  // Standing Steam anti-CSRF header rewrites so the core's autonomous session refresh and cancels
  // can reach Steam (DNR on Chrome, blocking webRequest on Firefox). Boot above does not depend on it.
  installSteamAntiCsrf();
});
