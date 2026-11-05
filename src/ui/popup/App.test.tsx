import { parseHTML } from 'linkedom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ACTIVATION_KEY } from '@/state/activation';
import { BLOCKING_KEY } from '@/state/blocking';
import { GUARD_VERDICTS_KEY, type OfferVerdicts } from '@/state/offerGuard';
import { loadSettings } from '@/config/settings';
import { REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_PARAM } from '@/infra/remoteConfig';
import { UPDATE_STATE_KEY } from '@/state/updateStatus';
import { App } from './App';

const VERDICTS: OfferVerdicts = {
  '9000000001': { level: 'IMPERSONATION', direction: 'sent', partnerSteamId: '76561198000000002', giveCount: 1, at: 0 },
};

/** Lets the storage reads resolve and Preact run the effects and renders they cause. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await act(() => new Promise<void>((r) => setTimeout(r, 0)));
}

describe('popup home screen and the suspicious-offer row', () => {
  const { document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const root = document.getElementById('root')!;
  let releaseVerdicts: (() => void) | undefined;
  let failVerdicts = false;

  beforeEach(async () => {
    vi.stubGlobal('document', document);
    releaseVerdicts = undefined;
    failVerdicts = false;
    await fakeBrowser.storage.local.set({ [ACTIVATION_KEY]: true, [BLOCKING_KEY]: 'NONE' });
    // Hold the verdict read until the test releases it (or fail it); every other read goes through.
    const session = fakeBrowser.storage.session;
    const get = session.get.bind(session) as (keys: string) => Promise<Record<string, unknown>>;
    const held = (keys: string): Promise<Record<string, unknown>> =>
      keys !== GUARD_VERDICTS_KEY
        ? get(keys)
        : failVerdicts
          ? Promise.reject(new Error('gone'))
          : new Promise((resolve) => (releaseVerdicts = () => resolve(get(keys))));
    vi.spyOn(session, 'get').mockImplementation(held as never);
  });

  afterEach(() => {
    render(null, root);
    vi.unstubAllGlobals();
  });

  it('holds the home screen until the first verdict read settles, then paints it with the row', async () => {
    await fakeBrowser.storage.session.set({ [GUARD_VERDICTS_KEY]: VERDICTS });
    await act(() => render(<App />, root));
    await settle();
    expect(root.querySelector('.screen-loading')).toBeTruthy();
    expect(root.querySelector('.home')).toBeNull();
    expect(root.querySelector('.offer-alert')).toBeNull();

    releaseVerdicts!();
    await settle();
    expect(root.querySelector('.screen-loading')).toBeNull();
    expect(root.querySelector('.home')).toBeTruthy();
    expect(root.querySelector('.offer-alert--danger')?.textContent).toContain("Check the deal in your cabinet");
  });

  it('paints the home screen alone when there is nothing to warn about', async () => {
    await act(() => render(<App />, root));
    await settle();
    expect(root.querySelector('.home')).toBeNull();

    releaseVerdicts!();
    await settle();
    expect(root.querySelector('.home')).toBeTruthy();
    expect(root.querySelector('.offer-alert')).toBeNull();
  });

  it('does not keep the home screen on the spinner when the verdict read fails', async () => {
    failVerdicts = true;
    await act(() => render(<App />, root));
    await settle();
    expect(root.querySelector('.home')).toBeTruthy();
    expect(root.querySelector('.offer-alert')).toBeNull();
  });
});

describe('popup home screen during a forced update', () => {
  const { document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const root = document.getElementById('root')!;

  beforeEach(async () => {
    vi.stubGlobal('document', document);
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 't', version: '1.0.5', version_name: '1.0.5-beta' });
    await fakeBrowser.storage.local.set({
      [ACTIVATION_KEY]: true,
      [BLOCKING_KEY]: 'NONE',
      [REMOTE_CONFIG_CACHE_KEY]: { [REMOTE_CONFIG_PARAM]: JSON.stringify({ web: { minExtensionVersion: '1.0.7' } }) },
    });
  });

  afterEach(async () => {
    render(null, root);
    vi.unstubAllGlobals();
    await fakeBrowser.storage.local.clear();
    await loadSettings();
  });

  async function homeTitle(state?: string, local: Record<string, unknown> = {}): Promise<string | undefined> {
    if (state !== undefined) await fakeBrowser.storage.session.set({ [UPDATE_STATE_KEY]: { min: '1.0.7', state } });
    await fakeBrowser.storage.local.set(local);
    await act(() => render(<App />, root));
    await settle();
    return root.querySelector('.screen-loading') ? 'LOADING' : root.querySelector('.home .title')?.textContent?.trim();
  }

  it.each(['restart_required', 'some_future_state'])('shows "Update required" when the state is %s', async (state) => {
    expect(await homeTitle(state)).toBe('Update required');
    expect(root.querySelector('.home .body-text')?.textContent).toBe(
      'Yours is out of date. Update it from the extensions page or restart your browser.',
    );
    expect(root.querySelector('.home .update-link')?.textContent).toBe('How to update?');
  });

  it.each([undefined, 'checking', 'applying'])('keeps the normal screen while the state is %s', async (state) => {
    expect(await homeTitle(state)).not.toMatch(/Update required|LOADING/);
  });

  it('keeps the normal screen when this build is at the minimum', async () => {
    expect(
      await homeTitle('restart_required', {
        [REMOTE_CONFIG_CACHE_KEY]: { [REMOTE_CONFIG_PARAM]: JSON.stringify({ web: { minExtensionVersion: '1.0.5' } }) },
      }),
    ).not.toMatch(/Update required|LOADING/);
  });

  it('holds the loading state until the update status is read', async () => {
    await fakeBrowser.storage.session.set({ [UPDATE_STATE_KEY]: { min: '1.0.7', state: 'restart_required' } });
    let release = (): void => {};
    const session = fakeBrowser.storage.session;
    const get = session.get.bind(session) as (keys: string) => Promise<Record<string, unknown>>;
    vi.spyOn(session, 'get').mockImplementation(((keys: string) =>
      keys === UPDATE_STATE_KEY ? new Promise((r) => (release = () => r(get(keys)))) : get(keys)) as never);
    await act(() => render(<App />, root));
    await settle();
    expect(root.querySelector('.screen-loading')).toBeTruthy();
    release();
    await settle();
    expect(root.querySelector('.home .title')?.textContent?.trim()).toBe('Update required');
  });

  it.each([
    ['DM_SESSION_MISSING', "You're signed out of DMarket"],
    ['STEAM_SESSION_MISSING', 'Sign in to Steam to keep tracking'],
    ['STEAM_ACCOUNT_MISMATCH', 'Wrong Steam account'],
  ])('lets %s stay above it', async (reason, title) => {
    expect(await homeTitle('restart_required', { [BLOCKING_KEY]: reason })).toBe(title);
  });

  it.each([
    ['the active screen', { [BLOCKING_KEY]: 'NONE' }],
    ['the paused screen', { [BLOCKING_KEY]: 'DM_CONNECTION_ERROR' }],
    ['onboarding', { [ACTIVATION_KEY]: false }],
  ])('replaces %s', async (_name, local) => {
    expect(await homeTitle('restart_required', local)).toBe('Update required');
  });

  async function openHowTo(): Promise<void> {
    await homeTitle('restart_required');
    await act(() => (root.querySelector('.update-link') as HTMLButtonElement).click());
    await settle();
  }

  const addressButton = (label: string): HTMLButtonElement =>
    root.querySelector(`.how-to__address[aria-label="${label}"]`) as HTMLButtonElement;

  it('opens "How to update" with the no-restart path first and the warning row hidden', async () => {
    await fakeBrowser.storage.session.set({ [GUARD_VERDICTS_KEY]: VERDICTS });
    await homeTitle('restart_required');
    expect(root.querySelector('.offer-alert')).toBeTruthy();

    await act(() => (root.querySelector('.update-link') as HTMLButtonElement).click());
    await settle();
    expect(root.querySelector('.home')).toBeNull();
    expect(root.querySelector('.offer-alert')).toBeNull();
    const titles = [...root.querySelectorAll('.how-to__title')].map((t) => t.textContent?.trim());
    expect(titles).toEqual(['Update without restarting', 'Update and restart browser']);
    expect(root.textContent).not.toMatch(/reinstall|remove|uninstall/i);
  });

  it('opens the extensions page in one click', async () => {
    const create = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never);
    await openHowTo();
    await act(() => addressButton('Open chrome://extensions').click());
    expect(create).toHaveBeenCalledWith({ url: 'chrome://extensions' });
    expect(addressButton('Copy chrome://extensions')).toBeNull();
  });

  it('offers to copy the extensions address when the tab is refused', async () => {
    vi.spyOn(fakeBrowser.tabs, 'create').mockRejectedValue(new Error('blocked'));
    await openHowTo();
    await act(() => addressButton('Open chrome://extensions').click());
    await settle();
    expect(addressButton('Copy chrome://extensions')).toBeTruthy();
    expect(root.querySelector('.how-to__hint')?.textContent).toContain('paste it into the address bar');
  });

  it('copies chrome://restart and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await openHowTo();
    await act(() => addressButton('Copy chrome://restart').click());
    await settle();
    expect(writeText).toHaveBeenCalledWith('chrome://restart');
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Copied chrome://restart.');
  });

  it('goes back to "Update required" with focus on the link', async () => {
    await openHowTo();
    // linkedom tracks no activeElement, so record which element focus() was called on.
    const focused: unknown[] = [];
    const proto = Object.getPrototypeOf(root.querySelector('.back-button')) as { focus(): void };
    vi.spyOn(proto, 'focus').mockImplementation(function (this: unknown) {
      focused.push(this);
    });
    await act(() => (root.querySelector('.back-button') as HTMLButtonElement).click());
    await settle();
    expect(root.querySelector('.home .title')?.textContent?.trim()).toBe('Update required');
    expect(focused.at(-1)).toBe(root.querySelector('.update-link'));
  });
});
