import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { initIcon } from '@/background/icon';
import { ACTIVATION_KEY } from '@/state/activation';
import { BLOCKING_KEY } from '@/state/blocking';
import { GUARD_VERDICTS_KEY } from '@/state/offerGuard';
import { UPDATE_STATE_KEY } from '@/state/updateStatus';
import { REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_PARAM } from '@/infra/remoteConfig';

const setIcon = vi.fn<(details: { path: Record<number, string> }) => Promise<void>>(() => Promise.resolve());
const setBadgeText = vi.fn<(details: { text: string }) => Promise<void>>(() => Promise.resolve());
const setBadgeBackgroundColor = vi.fn<(details: { color: string }) => Promise<void>>(() => Promise.resolve());

/** Which set the last `setIcon` call painted: `icon/<set>/16.png`, or `inactive` for the manifest default. */
const lastIcon = () => /^icon\/(?:(\w+)\/)?16\.png$/.exec(setIcon.mock.calls.at(-1)?.[0].path[16] ?? '')?.[1] ?? 'inactive';
const lastBadge = () => setBadgeText.mock.calls.at(-1)?.[0].text;
const lastBadgeColor = () => setBadgeBackgroundColor.mock.calls.at(-1)?.[0].color;

async function start(state: { activated: boolean; reason: string; update?: 'restart_required' | 'checking'; flagged?: boolean }) {
  await fakeBrowser.storage.local.set({ [ACTIVATION_KEY]: state.activated, [BLOCKING_KEY]: state.reason });
  if (state.update) {
    await fakeBrowser.storage.local.set({
      [REMOTE_CONFIG_CACHE_KEY]: { [REMOTE_CONFIG_PARAM]: JSON.stringify({ web: { minExtensionVersion: '1.0.7' } }) },
    });
    await fakeBrowser.storage.session.set({ [UPDATE_STATE_KEY]: { min: '1.0.7', state: state.update } });
  }
  if (state.flagged) {
    const verdict = { level: 'IMPERSONATION', partnerSteamId: '76561198000000001', at: Date.now(), direction: 'sent' };
    await fakeBrowser.storage.session.set({ [GUARD_VERDICTS_KEY]: { '1': verdict } });
  }
  initIcon();
  await vi.waitFor(() => {
    expect(setIcon).toHaveBeenCalled();
    expect(setBadgeText).toHaveBeenCalled();
  });
  // Both sources (state and verdicts) paint the badge; let the later one land before reading the last call.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('toolbar icon', () => {
  beforeEach(() => {
    setIcon.mockClear();
    setBadgeText.mockClear();
    setBadgeBackgroundColor.mockClear();
    Object.assign(fakeBrowser.action, { setIcon, setBadgeText, setBadgeBackgroundColor, setBadgeTextColor: () => Promise.resolve() });
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 't', version: '1.0.5' });
  });

  it.each([
    [true, 'NONE'],
    [false, 'NONE'],
    [true, 'DM_CONNECTION_ERROR'],
  ])('shows the grey icon with an orange "!" over activated=%s reason=%s while an update is required', async (activated, reason) => {
    await start({ activated, reason, update: 'restart_required' });
    expect(lastIcon()).toBe('inactive');
    expect(lastBadge()).toBe('!');
    expect(lastBadgeColor()).toBe('#FF9634');
  });

  it('keeps a sign-in state above the update', async () => {
    await start({ activated: true, reason: 'STEAM_SESSION_MISSING', update: 'restart_required' });
    expect(lastIcon()).toBe('mismatch');
    expect(lastBadge()).toBe('');
  });

  it('keeps the green icon while the update is still being checked', async () => {
    await start({ activated: true, reason: 'NONE', update: 'checking' });
    expect(lastIcon()).toBe('active');
    expect(lastBadge()).toBe('');
  });

  it.each([
    [true, 'NONE', 'active'],
    [false, 'NONE', 'inactive'],
    [true, 'DM_CONNECTION_ERROR', 'mismatch'],
  ])('without an update: activated=%s reason=%s → %s', async (activated, reason, icon) => {
    await start({ activated, reason });
    expect(lastIcon()).toBe(icon);
    expect(lastBadge()).toBe('');
  });

  it('lets the suspicious-offer "!" win the badge, in red, during an update', async () => {
    await start({ activated: true, reason: 'NONE', update: 'restart_required', flagged: true });
    expect(lastIcon()).toBe('inactive');
    expect(lastBadge()).toBe('!');
    expect(lastBadgeColor()).toBe('#e5484d');
  });

  it('shows the red "!" for flagged offers without an update', async () => {
    await start({ activated: true, reason: 'NONE', flagged: true });
    expect(lastIcon()).toBe('active');
    expect(lastBadge()).toBe('!');
    expect(lastBadgeColor()).toBe('#e5484d');
  });
});
