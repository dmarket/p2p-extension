import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MIRRORED_KEYS, registerStateMirror } from '@/background/stateMirror';
import { ACTIVATION_KEY, SET_ACTIVATION_KIND } from '@/state/activation';
import { BLOCKING_KEY, LINKED_STEAM_ID_KEY } from '@/state/blocking';
import { STATE_CHANGED_KIND, STATE_GET_KIND } from '@/state/stateArea';
import { flushMacrotasks } from '@/testing/stubs';


/** Fire the fake's onMessage listeners and capture what the handler passed to `sendResponse`. */
async function send(message: unknown, tabUrl: string | undefined, id = fakeBrowser.runtime.id): Promise<unknown> {
  let answer: unknown;
  const sender = { id, ...(tabUrl ? { tab: { url: tabUrl } } : {}) } as Browser.runtime.MessageSender;
  // Typed as an array, but the fake returns a promise (see background/router.test.ts).
  await (fakeBrowser.runtime.onMessage.trigger(message, sender, (r: unknown) => (answer = r)) as unknown as Promise<unknown>);
  await flushMacrotasks();
  return answer;
}

// The fake does not implement setAccessLevel.
const localAccess = vi.fn(() => Promise.resolve());
const sessionAccess = vi.fn(() => Promise.resolve());

describe('state mirror', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    // Vitest exposes the flag as the string "false", which is truthy; the build defines a real boolean.
    vi.stubEnv('FIREFOX', '');
    fakeBrowser.storage.local.setAccessLevel = localAccess;
    fakeBrowser.storage.session.setAccessLevel = sessionAccess;
  });

  it('closes both storage areas to content scripts and never opens either', async () => {
    await registerStateMirror();
    expect(localAccess).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(sessionAccess).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    for (const call of [...localAccess.mock.calls, ...sessionAccess.mock.calls] as unknown[][]) {
      expect(call[0]).not.toEqual({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
    }
  });

  it('no longer copies the mirrored keys into storage.session, and removes an older build\'s copy', async () => {
    await fakeBrowser.storage.session.set({ [BLOCKING_KEY]: 'NONE', steam_credential: 'secret' });
    await fakeBrowser.storage.local.set({ [BLOCKING_KEY]: 'STEAM_SESSION_MISSING' });
    await registerStateMirror();
    await fakeBrowser.storage.local.set({ [ACTIVATION_KEY]: true });
    await flushMacrotasks();
    const session = await fakeBrowser.storage.session.get(null);
    for (const k of MIRRORED_KEYS) expect(session).not.toHaveProperty(k);
    expect(session.steam_credential).toBe('secret'); // the core's, not ours to touch
  });

  it('answers state:get with the mirrored keys only, activation as an explicit boolean', async () => {
    await fakeBrowser.storage.local.set({ [BLOCKING_KEY]: 'STEAM_SESSION_MISSING', steam_credential: 'secret' });
    await fakeBrowser.storage.session.set({ steam_credential: 'secret' });
    await registerStateMirror();
    const answer = await send(
      { kind: STATE_GET_KIND, keys: [ACTIVATION_KEY, BLOCKING_KEY, LINKED_STEAM_ID_KEY, 'steam_credential'] },
      'https://dmarket.com/',
    );
    expect(answer).toEqual({ [ACTIVATION_KEY]: false, [BLOCKING_KEY]: 'STEAM_SESSION_MISSING', [LINKED_STEAM_ID_KEY]: null });
  });

  it('does not answer state:get for another extension', async () => {
    await fakeBrowser.storage.local.set({ [BLOCKING_KEY]: 'NONE' });
    await registerStateMirror();
    expect(await send({ kind: STATE_GET_KIND, keys: [BLOCKING_KEY] }, 'https://dmarket.com/', 'other-extension')).toBeUndefined();
  });

  it('pushes a change of a mirrored key to the tabs our content scripts run in', async () => {
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({
      manifest_version: 3,
      name: 'test',
      version: '1',
      content_scripts: [{ matches: ['https://dmarket.com/*'] }, { matches: ['https://steamcommunity.com/*/tradeoffers*'] }],
    });
    const query = vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([{ id: 7 }] as never);
    const sent = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    await registerStateMirror();
    await fakeBrowser.storage.local.set({ [ACTIVATION_KEY]: true, steam_credential: 'secret' });
    await flushMacrotasks();
    expect(query).toHaveBeenCalledWith({ url: ['https://dmarket.com/*', 'https://steamcommunity.com/*/tradeoffers*'] });
    expect(sent).toHaveBeenCalledWith(7, { kind: STATE_CHANGED_KIND, changes: { [ACTIVATION_KEY]: { newValue: true } } });
  });

  it('pushes nothing for a key it does not mirror', async () => {
    const sent = vi.spyOn(fakeBrowser.tabs, 'sendMessage');
    await registerStateMirror();
    await fakeBrowser.storage.local.set({ steam_credential: 'secret' });
    await flushMacrotasks();
    expect(sent).not.toHaveBeenCalled();
  });

  it('activates for the Steam content script', async () => {
    await registerStateMirror();
    const answer = await send({ kind: SET_ACTIVATION_KIND, enabled: true }, 'https://steamcommunity.com/id/x/tradeoffers/');
    expect(answer).toEqual({ ok: true });
    expect((await fakeBrowser.storage.local.get(ACTIVATION_KEY))[ACTIVATION_KEY]).toBe(true);
  });

  it.each([
    ['a dmarket tab', 'https://dmarket.com/', undefined],
    ['another extension', 'https://steamcommunity.com/id/x/tradeoffers/', 'other-extension'],
    ['no tab', undefined, undefined],
  ])('refuses %s', async (_, url, id) => {
    await registerStateMirror();
    const answer = await send({ kind: SET_ACTIVATION_KIND, enabled: true }, url, id);
    expect(answer).toEqual({ ok: false, error: 'sender not allowed' });
    expect(await fakeBrowser.storage.local.get(ACTIVATION_KEY)).toEqual({});
  });

  it('ignores a deactivation request', async () => {
    await fakeBrowser.storage.local.set({ [ACTIVATION_KEY]: true });
    await registerStateMirror();
    expect(await send({ kind: SET_ACTIVATION_KIND, enabled: false }, 'https://steamcommunity.com/')).toBeUndefined();
    expect((await fakeBrowser.storage.local.get(ACTIVATION_KEY))[ACTIVATION_KEY]).toBe(true);
  });
});
