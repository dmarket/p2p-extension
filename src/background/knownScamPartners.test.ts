import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyKnownScamPartners, forwardKnownScamPartners } from '@/background/knownScamPartners';
import { loadSettings } from '@/config/settings';
import type { TrackerHandle } from '@/core/tracker';
import { flushMacrotasks, publishRemoteConfig } from '@/testing/stubs';

const { setKnownScamPartners } = vi.hoisted(() => ({ setKnownScamPartners: vi.fn(() => true) }));
vi.mock('@/core/tracker', () => ({ Tracker: { setKnownScamPartners } }));

const SCAM = '76561198781084366';
const OTHER = '76561198000000002';
const handle = {} as TrackerHandle;

describe('the known-scam list for the core', () => {
  beforeEach(async () => {
    await publishRemoteConfig({});
    await loadSettings();
    setKnownScamPartners.mockClear();
  });

  it('sends the published list at boot', async () => {
    await publishRemoteConfig({ web: { knownScamPartners: [SCAM] } });
    await loadSettings();
    applyKnownScamPartners(handle);
    expect(setKnownScamPartners).toHaveBeenCalledWith(handle, [SCAM]);
  });

  it('sends nothing before a document carries a list, so the core keeps the one compiled into it', () => {
    applyKnownScamPartners(handle);
    expect(setKnownScamPartners).not.toHaveBeenCalled();
  });

  it('sends a published empty list: that is how a wrong entry is taken back', async () => {
    await publishRemoteConfig({ web: { knownScamPartners: [] } });
    await loadSettings();
    applyKnownScamPartners(handle);
    expect(setKnownScamPartners).toHaveBeenCalledWith(handle, []);
  });

  it('sends a changed list to the running core, and nothing while no core runs', async () => {
    let running: TrackerHandle | undefined = undefined;
    const stop = forwardKnownScamPartners(() => running);
    await publishRemoteConfig({ web: { knownScamPartners: [SCAM] } });
    await flushMacrotasks();
    expect(setKnownScamPartners).not.toHaveBeenCalled();
    running = handle;
    await publishRemoteConfig({ web: { knownScamPartners: [SCAM, OTHER] } });
    await vi.waitFor(() => expect(setKnownScamPartners).toHaveBeenCalledWith(handle, [SCAM, OTHER]));
    stop();
  });
});
