import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { MIRRORED_KEYS, registerStateMirror } from '@/background/stateMirror';
import { ACTIVATION_KEY, SET_ACTIVATION_KIND } from '@/state/activation';
import { BLOCKING_KEY } from '@/state/blocking';
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

  it('closes storage.local to content scripts and opens storage.session', async () => {
    await registerStateMirror();
    expect(localAccess).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(sessionAccess).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
    });
  });

  it('still mirrors when the browser rejects setAccessLevel on storage.local', async () => {
    fakeBrowser.storage.local.setAccessLevel = vi.fn(() => {
      throw new Error('unsupported');
    });
    await fakeBrowser.storage.local.set({ [BLOCKING_KEY]: 'NONE' });
    await registerStateMirror();
    expect((await fakeBrowser.storage.session.get(BLOCKING_KEY))[BLOCKING_KEY]).toBe('NONE');
  });

  it('copies the mirrored keys into storage.session, and an unset activation as false', async () => {
    await fakeBrowser.storage.local.set({ [BLOCKING_KEY]: 'STEAM_SESSION_MISSING', steam_credential: 'secret' });
    await registerStateMirror();
    const session = await fakeBrowser.storage.session.get(null);
    expect(MIRRORED_KEYS).toContain(BLOCKING_KEY);
    expect(session[BLOCKING_KEY]).toBe('STEAM_SESSION_MISSING');
    expect(session[ACTIVATION_KEY]).toBe(false);
    expect(session).not.toHaveProperty('steam_credential');
  });

  it('follows later writes to storage.local', async () => {
    await registerStateMirror();
    await fakeBrowser.storage.local.set({ [ACTIVATION_KEY]: true });
    await flushMacrotasks();
    await flushMacrotasks();
    expect((await fakeBrowser.storage.session.get(ACTIVATION_KEY))[ACTIVATION_KEY]).toBe(true);
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
