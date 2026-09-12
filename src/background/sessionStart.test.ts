import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { claimSessionStart } from '@/background/sessionStart';

// The boot forces a heartbeat on the first spawn of a browser session, because the verdict it restores
// from storage may predate a sign-out nobody was awake to see. These pin the claim's shape: once per
// session, marked in `storage.session`, and forcing rather than trusting when that storage is not there.

const SESSION_KEY = 'boot.heartbeatForcedForBrowserSession';

describe('the session-start claim', () => {
  it('is granted to the first spawn of a browser session, and marks it', async () => {
    await expect(claimSessionStart()).resolves.toBe(true);
    expect((await fakeBrowser.storage.session.get(SESSION_KEY))[SESSION_KEY]).toBe(true);
  });

  it('is refused to every later respawn in the same session', async () => {
    await claimSessionStart();

    await expect(claimSessionStart()).resolves.toBe(false);
    await expect(claimSessionStart()).resolves.toBe(false);
  });

  it('is granted again once the session storage is gone — a re-enable, a reload, a browser restart', async () => {
    await claimSessionStart();
    // What the browser does to `storage.session` in each of those windows.
    await fakeBrowser.storage.session.clear();

    await expect(claimSessionStart()).resolves.toBe(true);
  });

  it('forces rather than trusts when the mark cannot be read', async () => {
    vi.spyOn(fakeBrowser.storage.session, 'get').mockRejectedValueOnce(new Error('storage unavailable'));

    // A stale verdict is the failure this exists to prevent; one extra heartbeat is the cheaper side.
    await expect(claimSessionStart()).resolves.toBe(true);
  });
});
