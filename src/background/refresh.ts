// On-demand core re-evaluation of a session, triggered by the host events the core itself cannot
// observe: the `dm-trade-token` cookie changing (a DMarket login/logout) and the Steam session cookie
// changing (a Steam login/logout).
//
// The core only re-checks either session while running a cycle, on the backend-ttl cadence — and a
// respawned worker with nothing to watch idles *before* it looks at any credential — so between
// heartbeats a logout (or a recovered session) would go unnoticed for up to a full ttl and the UI would
// show a stale "Trade tracking is ON". A cookie change is the reactive signal that closes that gap: it
// nudges the core to re-evaluate NOW via `Tracker.forceHeartbeat` (which marks the heartbeat due, so the
// immediate cycle re-reads both sessions and re-resolves the blocking reason); the extension then mirrors
// whatever the core reports. This is purely a WAKE signal — the extension derives no state and reads no
// cookie value (the core owns that: the marketplace cookie at its own configured FE origin, and the
// Steam one whose mere presence is not proof of a live session anyway), so switching FE/API URLs in the
// debug console needs no change here. Registered at top level so a cookie change wakes the MV3 worker.
//
// This is deliberately the ONLY host-initiated heartbeat trigger besides the dev debug console's
// force-tick: heartbeats are schedule/event-driven, never view-driven (opening the popup does not
// force one — blocked states never advance the schedule, so the boot cycle of the worker the popup
// wakes re-evaluates them anyway).
//
// Debounced + in-flight-guarded: forceHeartbeat is a network POST and a token can rotate in bursts.
// Seeded to 0 (NOT "now"): in MV3 the cookie change usually SPAWNS the worker it lands on, so a
// "now" seed would swallow the very nudge that woke us — and since the core honours the persisted
// heartbeat cadence across respawns (boot cycles idle inside a live ttl window, core ≥ .104), this
// nudge is the only thing that surfaces a logout/login before the next due tick. When the boot cycle
// DID heartbeat (first start / past due), the forced cycle behind it is serialised by the core's
// mutex and is one redundant POST at most — the debounce still collapses bursts after that.
//
// PERMISSION GOTCHA — the reason a cookie change can go unseen entirely. Chrome gates
// `cookies.onChanged` (and `cookies.getAll`) on a host permission for a URL derived from the COOKIE,
// not from the page that set it: `(secure ? https : http)://<Domain without leading dot>/`. So a
// session cookie scoped to a PARENT domain, or served without `Secure`, raises no event here even
// though the FE origin itself is permitted — while the tracker keeps working, because `cookies.get`
// (what the core's scrape uses) does not apply that filter. Symptom: login/logout is invisible on the
// affected environment and only surfaces when the stale token is finally rejected. Prod is covered by
// the `https://dmarket.com/*` pattern; dev/stage need WXT_DEV_COOKIE_DOMAINS (see wxt.config.ts).
//
// Both suppressors are LOSSLESS: whatever they drop is re-fired once the window closes. Dropping the
// last event of a burst is the one thing this must never do, because the burst is exactly what an
// account change looks like — signing out deletes the session cookie and signing back in writes it
// again moments later, so the SET (the event carrying the state the user is waiting to see) lands
// inside the window opened by the DELETE. Without a trailing re-fire the UI would keep showing the
// logged-out/wrong-account state until the next due heartbeat, i.e. up to a full backend ttl.

import { Tracker, type TrackerHandle } from '@/core/tracker';
import { getMarketplaceCookieName, getSteamSessionCookieName, getSettings } from '@/config/settings';
import { STEAM_INTEGRATION } from '@/config/steam';
import { getBlockingReason } from '@/state/blocking';

// Debounce window is remote-config-tunable (web.refreshDebounceMs, default 3000); read at use time.
// One timestamp per axis, so a rotating cookie on one side can't starve the other's nudge — and, for the
// same reason, one in-flight flag per axis: a single shared flag let a marketplace nudge silently eat a
// Steam one, and the two axes move together on an account change (signing into DMarket and signing into
// Steam are what the user does back to back).
const lastRefreshAt = { marketplace: 0, steam: 0 };
const refreshInFlight = { marketplace: false, steam: false };
/**
 * Called with the handle once a nudged cycle has settled, so the caller can re-read whatever the core
 * resolved. Required, not cosmetic: the cycle that ESTABLISHES a block can emit no event carrying it — the
 * Steam credential gate sets the missing-session flag and returns without emitting anything unless a
 * re-login also failed, and `CycleStarted` already went out before the gate ran. Without this, a sign-out
 * detected by the cookie watch leaves the popup/banner/icon on the previous state until the next tick.
 */
let onCycleSettled: ((handle: TrackerHandle) => void) | undefined;
// An axis whose nudge was suppressed (debounced, or arrived mid-flight), re-fired exactly once when the
// suppressor clears — see the "lossless" note above.
const refreshPending = { marketplace: false, steam: false };

type Axis = keyof typeof lastRefreshAt;

/**
 * Nudge the core to re-evaluate its sessions now (debounced per axis, guarded against pile-up).
 *
 * Takes the handle GETTER, not a handle: a deferred nudge must run against whatever core is live when it
 * fires, since a remote-config override or a debug endpoint switch replaces the handle in between.
 */
function nudgeReeval(getHandle: () => TrackerHandle | undefined, axis: Axis): void {
  const handle = getHandle();
  if (handle === undefined) return;
  // A cycle for this axis is already running: it may have read the session BEFORE this change landed, so
  // its verdict can already be stale. Remember to run one more once it settles.
  if (refreshInFlight[axis]) {
    refreshPending[axis] = true;
    return;
  }
  const now = Date.now();
  const debounceMs = getSettings().web.refreshDebounceMs;
  const sinceLast = now - lastRefreshAt[axis];
  if (sinceLast < debounceMs) {
    // Inside the window — collapse into ONE trailing nudge rather than dropping this event. Only the
    // first suppressed event arms the timer; the rest coalesce into it, so a burst still costs at most
    // two forced heartbeats (leading + trailing) however many cookie writes it contains.
    //
    // The timer is the only state here that an MV3 worker teardown can lose. Acceptable: a killed worker
    // means no cycle is running to be stale, the next event respawns it, and reconcileSteamSession runs on
    // that spawn — with the due heartbeat as the final backstop.
    if (!refreshPending[axis]) {
      refreshPending[axis] = true;
      setTimeout(() => {
        if (!refreshPending[axis]) return;
        refreshPending[axis] = false;
        nudgeReeval(getHandle, axis);
      }, debounceMs - sinceLast);
    }
    return;
  }
  lastRefreshAt[axis] = now;
  refreshInFlight[axis] = true;
  void Tracker.forceHeartbeat(handle)
    .then(() => onCycleSettled?.(handle))
    .catch(() => {
      /* offline / handle torn down — the next scheduled heartbeat re-evaluates anyway */
    })
    .finally(() => {
      refreshInFlight[axis] = false;
      if (refreshPending[axis]) {
        refreshPending[axis] = false;
        nudgeReeval(getHandle, axis);
      }
    });
}

/**
 * Register the host-only re-evaluation triggers (session-cookie changes). Call synchronously on every
 * worker spawn (alongside registerBridgeRouter). `getHandle` returns the current tracker handle
 * (undefined if boot failed); `afterCycle` is invoked once a nudged cycle has settled — see
 * {@link onCycleSettled} for why that callback is load-bearing.
 */
export function registerRefreshTriggers(
  getHandle: () => TrackerHandle | undefined,
  afterCycle?: (handle: TrackerHandle) => void,
): void {
  onCycleSettled = afterCycle;
  // A session cookie changed (login/logout) — the reactive signal the core can't see. Both names are
  // resolved at event time (remote override or the compiled default) so they always track whatever the
  // running core is reading; watched by NAME only, never their value or origin.
  browser.cookies.onChanged.addListener((change) => {
    // Drop the removal half of an OVERWRITE, and only that. Chrome implements a cookie update as
    // remove-then-write and emits two events — `{removed: true, cause: 'overwrite'}` then
    // `{removed: false, cause: 'explicit'}` — so without this filter every rotation costs two nudges, which is
    // now self-inflicted on the happy path: the core rotates these cookies itself on each token refresh.
    //
    // Keyed on the CAUSE, not on `removed` alone. A real logout deletes the cookie and writes nothing after
    // it (`cause: 'explicit'`), and an expiry is `'expired'` — dropping those would make a sign-out invisible
    // until the next due heartbeat, i.e. up to a full backend ttl, which is precisely the gap this listener
    // exists to close.
    if (change.removed && change.cause === 'overwrite') return;
    const name = change.cookie.name;
    if (name === getMarketplaceCookieName()) nudgeReeval(getHandle, 'marketplace');
    // Steam issues one audience-scoped session cookie PER domain (community / store / help), but the core
    // judges the session by the community one alone — so only that domain's change is news. Without the
    // domain filter a store-side rotation nudges a cycle that then re-reads an unchanged community cookie.
    else if (name === getSteamSessionCookieName() && isCommunityCookieDomain(change.cookie.domain)) {
      nudgeReeval(getHandle, 'steam');
    }
  });
}

/** True for the Steam community host the core reads its session cookie from (cookie domains may lead with a dot). */
function isCommunityCookieDomain(domain: string): boolean {
  const host = new URL(STEAM_INTEGRATION.communityUrl).host;
  return domain === host || domain === '.' + host;
}

/**
 * The Steam blocks a signed-in cookie session can settle — both of which the user fixes the same way
 * (sign into the linked Steam account) and neither of which a cookie event can catch when it happens
 * while this extension isn't running.
 */
const STEAM_COOKIE_RECOVERABLE = new Set(['STEAM_SESSION_MISSING', 'STEAM_ACCOUNT_MISMATCH']);

/** Session-storage key holding the fingerprint of the Steam session cookie the last reconcile nudged on. */
const RECONCILED_KEY = 'steam.reconciledSessionFingerprint';

/**
 * A short, non-reversible fingerprint of a cookie value — enough to answer "is this the same session as last
 * time", never enough to reconstruct the session. SHA-256 via WebCrypto (available in the MV3 worker),
 * truncated because only equality is ever compared.
 */
async function fingerprintCookie(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Recovery backstop for the one case no cookie event covers: the user signed back into Steam while this
 * extension wasn't running (browser restarted, extension reloaded/updated), so the persisted Steam block
 * is stale-true and — inside a live backend-ttl window with nothing to watch — the core would idle
 * without re-checking the session for up to a ttl. One cookie read settles whether to wake it; the core
 * still owns the verdict. Deliberately not a poll and not view-driven.
 *
 * Covers the wrong-account block for exactly the same reason as the missing-session one: signing into the
 * right account off-hours leaves an equally stale prompt, and the remedy is the same single nudge. On that
 * axis the cookie is present throughout, so the nudge is gated on its VALUE having changed since the last
 * one — otherwise every spawn of a wrong-account episode would spend a forced heartbeat re-arming the core's
 * per-episode retries.
 *
 * Call once per spawn AFTER the core is started (it needs a handle to nudge, and the resolved cookie
 * name needs the loaded settings snapshot). Never throws.
 */
export async function reconcileSteamSession(getHandle: () => TrackerHandle | undefined): Promise<void> {
  try {
    if (!STEAM_COOKIE_RECOVERABLE.has(await getBlockingReason())) return;
    const cookie = await browser.cookies.get({
      url: STEAM_INTEGRATION.communityUrl,
      name: getSteamSessionCookieName(),
    });
    if (!cookie) return;
    // Nudge only when the session actually MOVED since the last nudge, not on mere presence. Presence alone
    // is true on every spawn of a wrong-account episode (the cookie is a perfectly healthy session — it just
    // belongs to the other account), and each nudge is a forced heartbeat, which re-arms the core's
    // once-per-episode retries. Fingerprinted rather than stored verbatim: this is a session credential, and
    // session storage is not a place to keep one.
    const fingerprint = await fingerprintCookie(cookie.value);
    const seen = (await browser.storage.session.get(RECONCILED_KEY))[RECONCILED_KEY];
    if (seen === fingerprint) return;
    await browser.storage.session.set({ [RECONCILED_KEY]: fingerprint });
    nudgeReeval(getHandle, 'steam');
  } catch {
    /* no cookies permission for the URL / storage unavailable — the next due tick re-evaluates */
  }
}
