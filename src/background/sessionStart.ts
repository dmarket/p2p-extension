// Is this the first worker spawn of a browser session? The answer decides whether the boot may trust
// the verdict it restores from storage, or has to re-earn it.
//
// THE GAP. The core's boot cycle heartbeats only when the persisted schedule says it is due; a respawn
// inside a live ttl window idles, on the reasoning that an idle can only follow a recent successful
// heartbeat, when the restored all-clear is still truthful. That holds for the eviction the reasoning
// was written for — Chrome killing an idle worker and respawning it seconds later. It does not hold
// for a DISABLED extension, a reload, an update or a browser restart: the user can sign out of
// DMarket (or Steam) during any of those, the cookie watch that would have noticed never existed at
// the time, and the re-enabled worker restores a `NONE` mirror and a not-yet-due schedule. Result: a
// green icon, a "Trade tracking is ON" popup and an `is_tracking_active: true` pong, for up to a full
// ttl, with no DMarket session behind any of them.
//
// THE SIGNAL is the same one src/background/inject-content-scripts.ts uses for re-injection: a mark in
// `storage.session`, which the browser clears in precisely those windows and nowhere else. The first
// spawn to find it absent forces a heartbeat — one extra POST per browser session or re-enable, and a
// verdict that was actually re-derived rather than remembered.
//
// CLAIMED FIRST, not after the heartbeat lands: a worker killed inside its own boot second is not a
// case Chrome produces (eviction follows idleness), and the due tick is the backstop regardless.
// Marking late would instead let a slow heartbeat and a quick respawn stack a second forced POST.

const SESSION_KEY = 'boot.heartbeatForcedForBrowserSession';

/**
 * `true` once per browser session — on the spawn that finds no mark — and `false` on every respawn
 * after it. A mark that cannot be read or written reads as `true`: an extra heartbeat is cheaper than
 * a stale verdict, which is the failure this exists to prevent.
 */
export async function claimSessionStart(): Promise<boolean> {
  try {
    if ((await browser.storage.session.get(SESSION_KEY))[SESSION_KEY] === true) return false;
    await browser.storage.session.set({ [SESSION_KEY]: true });
  } catch {
    /* session storage unavailable — force, do not trust the restored verdict */
  }
  return true;
}
