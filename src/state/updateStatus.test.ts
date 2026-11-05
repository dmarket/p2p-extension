import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { loadSettings } from '@/config/settings';
import { REMOTE_CONFIG_CACHE_KEY, REMOTE_CONFIG_PARAM } from '@/infra/remoteConfig';
import { getUpdateStatus, needsUpdateScreen, parseStoredUpdateState, resolveUpdateStatus } from '@/state/updateStatus';

describe('resolveUpdateStatus', () => {
  it('requires nothing without a minimum, or at or above it', () => {
    expect(resolveUpdateStatus({ min: undefined, own: '1.0.5', stored: undefined })).toEqual({ required: false, state: 'none' });
    expect(resolveUpdateStatus({ min: '1.0.5', own: '1.0.5', stored: undefined })).toEqual({
      required: false,
      minVersion: '1.0.5',
      state: 'none',
    });
    expect(resolveUpdateStatus({ min: '1.0.5', own: '1.1', stored: { min: '1.0.5', state: 'restart_required' } }).state).toBe('none');
  });

  it('says checking below the minimum until the worker has a state for that minimum', () => {
    expect(resolveUpdateStatus({ min: '1.0.7', own: '1.0.5', stored: undefined })).toEqual({
      required: true,
      minVersion: '1.0.7',
      state: 'checking',
    });
    // A state reached for another minimum is a different rule.
    expect(resolveUpdateStatus({ min: '1.0.7', own: '1.0.5', stored: { min: '1.0.6', state: 'restart_required' } }).state).toBe('checking');
  });

  it.each(['checking', 'applying', 'restart_required', 'some_future_state'])('passes the stored %s through', (state) => {
    expect(resolveUpdateStatus({ min: '1.0.7', own: '1.0.5', stored: { min: '1.0.7', state } }).state).toBe(state);
  });
});

describe('needsUpdateScreen', () => {
  it.each([
    [{ required: false, state: 'none' }, false],
    [{ required: true, state: 'checking' }, false],
    [{ required: true, state: 'applying' }, false],
    [{ required: true, state: 'restart_required' }, true],
    [{ required: true, state: 'some_future_state' }, true],
  ])('%j → %s', (status, expected) => {
    expect(needsUpdateScreen(status)).toBe(expected);
  });
});

describe('parseStoredUpdateState', () => {
  it('keeps any string state and refuses malformed records', () => {
    expect(parseStoredUpdateState({ min: '1.0.7', state: 'x' })).toEqual({ min: '1.0.7', state: 'x' });
    for (const bad of [undefined, null, 'x', { min: 1, state: 'x' }, { min: '1.0.7' }, { min: '1.0.7', state: '' }]) {
      expect(parseStoredUpdateState(bad)).toBeUndefined();
    }
  });
});

describe('getUpdateStatus as an extension page reads it', () => {
  beforeEach(() => {
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 't', version: '1.0.5', version_name: '1.0.5-beta' });
  });

  const publish = (min: string) =>
    fakeBrowser.storage.local.set({ [REMOTE_CONFIG_CACHE_KEY]: { [REMOTE_CONFIG_PARAM]: JSON.stringify({ web: { minExtensionVersion: min } }) } });

  it('combines the published minimum, the numeric own version and the stored state', async () => {
    await publish('1.0.7');
    await fakeBrowser.storage.session.set({ 'update.forced': { min: '1.0.7', state: 'restart_required' } });
    expect(await getUpdateStatus()).toEqual({ required: true, minVersion: '1.0.7', state: 'restart_required' });
  });

  it('takes the debug console minimum over the published one in a dev build', async () => {
    await publish('1.0.0');
    await fakeBrowser.storage.local.set({ 'debug.minExtensionVersion': '1.0.6' });
    expect(await getUpdateStatus()).toMatchObject({ required: true, minVersion: '1.0.6' });
    await fakeBrowser.storage.local.clear();
    await loadSettings();
  });
});
