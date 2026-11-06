import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { applyCreatesPause, forwardCreatesPause } from '@/background/createsPause';
import { loadSettings } from '@/config/settings';
import type { TrackerHandle } from '@/core/tracker';
import { UPDATE_STATE_KEY } from '@/state/updateStatus';
import { publishRemoteConfig } from '@/testing/stubs';

const { setCreatesPaused } = vi.hoisted(() => ({ setCreatesPaused: vi.fn() }));
vi.mock('@/core/tracker', () => ({ Tracker: { setCreatesPaused } }));

const first = { id: 1 } as unknown as TrackerHandle;
const second = { id: 2 } as unknown as TrackerHandle;

const withMinimum = async (min: string) => {
  await publishRemoteConfig({ web: { minExtensionVersion: min } });
  await loadSettings();
};

beforeEach(async () => {
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({
    manifest_version: 3,
    name: 'test',
    version: '1.0.5',
    version_name: '1.0.5-beta',
  });
  await publishRemoteConfig({});
  await loadSettings();
  setCreatesPaused.mockClear();
});

describe('offer creation while a forced update is pending', () => {
  it('is paused whenever an update is required, whatever state the update has reached', async () => {
    await withMinimum('1.0.7');
    for (const state of ['checking', 'applying', 'restart_required']) {
      await fakeBrowser.storage.session.set({ [UPDATE_STATE_KEY]: { min: '1.0.7', state } });
      setCreatesPaused.mockClear();
      applyCreatesPause(first);
      expect(setCreatesPaused, state).toHaveBeenCalledWith(first, true);
    }
  });

  it('is not paused with no minimum, or once the build meets it', async () => {
    applyCreatesPause(first);
    expect(setCreatesPaused).toHaveBeenLastCalledWith(first, false);
    await withMinimum('1.0.5');
    applyCreatesPause(first);
    expect(setCreatesPaused).toHaveBeenLastCalledWith(first, false);
  });

  it('is sent again to the next core after a respawn or a restart', async () => {
    await withMinimum('1.0.7');
    applyCreatesPause(first);
    applyCreatesPause(second);
    expect(setCreatesPaused.mock.calls).toEqual([
      [first, true],
      [second, true],
    ]);
  });

  it('follows the minimum on the running core: paused when it is published, resumed when it is lifted', async () => {
    const stop = forwardCreatesPause(() => first);
    await withMinimum('1.0.7');
    await vi.waitFor(() => expect(setCreatesPaused).toHaveBeenLastCalledWith(first, true));
    await withMinimum('1.0.5');
    await vi.waitFor(() => expect(setCreatesPaused).toHaveBeenLastCalledWith(first, false));
    stop();
  });

  it('sends nothing while no core runs', async () => {
    const stop = forwardCreatesPause(() => undefined);
    await withMinimum('1.0.7');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(setCreatesPaused).not.toHaveBeenCalled();
    stop();
  });
});
