import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { syncDebugFeBridge } from '@/debug/feBridge';

// The debug console's FE switch only works if the page bridge actually runs on the new FE: the manifest
// carries the build-time FE origins only, so a missing registration shows on the page as "installed but not
// answering", with nothing in any log.

const { logCommand } = vi.hoisted(() => ({ logCommand: vi.fn(() => Promise.resolve()) }));
vi.mock('@/debug/netLog', () => ({ logCommand }));

// `scripting` and `permissions` are `notMockedFunction`s in fake-browser; cast for the same reason as in
// background/inject-content-scripts.test.ts.
type Registered = { id: string; matches?: string[]; js?: string[]; runAt?: string };
type ScriptingHost = {
  getRegisteredContentScripts(f: { ids: string[] }): Promise<Registered[]>;
  registerContentScripts(s: Registered[]): Promise<void>;
  unregisterContentScripts(f: { ids: string[] }): Promise<void>;
};
type PermissionsHost = { contains(p: { origins: string[] }): Promise<boolean> };
type ManifestHost = { getManifest(): { content_scripts?: unknown[] } };

const BRIDGE = { js: ['content-scripts/dmarket-bridge.js'], matches: ['https://dmarket.com/*', 'https://p2p.dev.example/*'] };
const BANNER = { js: ['content-scripts/steam-tradeoffers.js'], matches: ['https://steamcommunity.com/*'] };

function stub(registered: Registered[], hasPermission: (pattern: string) => boolean = () => true) {
  const scripting = fakeBrowser.scripting as unknown as ScriptingHost;
  vi.spyOn(fakeBrowser.runtime as unknown as ManifestHost, 'getManifest').mockReturnValue({
    content_scripts: [BANNER, BRIDGE],
  });
  vi.spyOn(fakeBrowser.permissions as unknown as PermissionsHost, 'contains').mockImplementation(({ origins }) =>
    Promise.resolve(origins.every(hasPermission)),
  );
  return {
    get: vi.spyOn(scripting, 'getRegisteredContentScripts').mockResolvedValue(registered),
    register: vi.spyOn(scripting, 'registerContentScripts').mockResolvedValue(undefined),
    unregister: vi.spyOn(scripting, 'unregisterContentScripts').mockResolvedValue(undefined),
  };
}

const record = (...origins: string[]) => fakeBrowser.storage.local.set({ 'debug.allowedOrigins': origins });

beforeEach(async () => {
  logCommand.mockClear();
  await fakeBrowser.storage.local.clear();
});

describe('the page bridge on a debug-console FE', () => {
  it('registers the manifest bridge file on a recorded origin the manifest lacks, and only there', async () => {
    const api = stub([]);
    await record('https://p2p.dev.example', 'https://main.dev.example');

    await syncDebugFeBridge(true);

    expect(api.register).toHaveBeenCalledWith([
      { id: 'debug-fe-bridge', matches: ['https://main.dev.example/*'], js: BRIDGE.js, runAt: 'document_idle' },
    ]);
    expect(logCommand).toHaveBeenCalledWith('FeBridge', expect.stringContaining('https://main.dev.example/*'), 'info');
  });

  it('skips an origin without a host permission and says so', async () => {
    const api = stub([], (p) => p !== 'https://elsewhere.example/*');
    await record('https://elsewhere.example');

    await syncDebugFeBridge(true);

    expect(api.register).not.toHaveBeenCalled();
    expect(logCommand).toHaveBeenCalledWith('FeBridge', expect.stringContaining('no host permission'), 'error');
  });

  it('leaves a matching registration alone, and logs nothing on a worker spawn', async () => {
    const api = stub([{ id: 'debug-fe-bridge', matches: ['https://main.dev.example/*'] }]);
    await record('https://main.dev.example');

    await syncDebugFeBridge();

    expect(api.unregister).not.toHaveBeenCalled();
    expect(api.register).not.toHaveBeenCalled();
    expect(logCommand).not.toHaveBeenCalled();
  });

  it('drops the registration once no recorded origin needs it', async () => {
    const api = stub([{ id: 'debug-fe-bridge', matches: ['https://main.dev.example/*'] }]);
    await record('https://p2p.dev.example');

    await syncDebugFeBridge();

    expect(api.unregister).toHaveBeenCalledWith({ ids: ['debug-fe-bridge'] });
    expect(api.register).not.toHaveBeenCalled();
  });
});
