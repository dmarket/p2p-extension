import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getMarketplaceCookieName } from '@/config/settings';
import type { TrackerHandle } from '@/core/tracker';

const { forceHeartbeat } = vi.hoisted(() => ({ forceHeartbeat: vi.fn(() => Promise.resolve()) }));
vi.mock('@/core/tracker', () => ({ Tracker: { forceHeartbeat } }));

import { registerRefreshTriggers } from './refresh';

type CookieListener = Parameters<typeof fakeBrowser.cookies.onChanged.addListener>[0];
type ChangeInfo = Parameters<CookieListener>[0];

const handle = {} as TrackerHandle;

/** fake-browser has no in-memory `cookies.onChanged`, so capture the listener the module registers. */
function registerAndCapture(): CookieListener {
  let listener: CookieListener | undefined;
  vi.spyOn(fakeBrowser.cookies.onChanged, 'addListener').mockImplementation((l) => {
    listener = l;
  });
  registerRefreshTriggers(() => handle);
  if (!listener) throw new Error('registerRefreshTriggers registered no cookies.onChanged listener');
  return listener;
}

describe('registerRefreshTriggers', () => {
  it('ignores a cookies.onChanged call that carries no change info', () => {
    const listener = registerAndCapture();

    // The shape a WebKit host delivers: the listener is invoked without its argument.
    expect(() => listener(undefined as unknown as ChangeInfo)).not.toThrow();
    expect(forceHeartbeat).not.toHaveBeenCalled();
  });

  it('still nudges the core on a real session-cookie change', () => {
    const listener = registerAndCapture();

    listener({
      removed: true,
      cause: 'explicit',
      cookie: { name: getMarketplaceCookieName(), domain: '.dmarket.com' } as ChangeInfo['cookie'],
    });
    expect(forceHeartbeat).toHaveBeenCalledWith(handle);
  });
});
