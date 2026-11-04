import { parseHTML } from 'linkedom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ACTIVATION_KEY } from '@/state/activation';
import { BLOCKING_KEY } from '@/state/blocking';
import { GUARD_VERDICTS_KEY, type OfferVerdicts } from '@/state/offerGuard';
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
