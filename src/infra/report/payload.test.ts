import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { INSTALL_ID_KEY } from '@/infra/report/keys';
import { buildPayload } from '@/infra/report/payload';
import { setReportingEnabledByUser } from '@/infra/report/consent';
import { stubManifest } from '@/testing/stubs';

// The payload's identity contract: `deviceId` is dmarket.com's own `dm_did` analytics id when the browser has
// one, so extension rows collate with the same browser's web rows (the collector owner's requirement), and our
// own install id otherwise.

const report = { context: 'background' as const, message: 'boom', stack: null, timestamp: '2026-10-30T00:00:00.000Z' };

const storedInstallId = async (): Promise<unknown> =>
  (await browser.storage.local.get(INSTALL_ID_KEY))[INSTALL_ID_KEY];

// fake-browser does not implement cookies.get; each test decides what the jar holds (empty by default).
const jar = () => vi.spyOn(fakeBrowser.cookies, 'get');
beforeEach(() => {
  stubManifest([]);
  jar().mockResolvedValue(null as never);
});

describe('deviceId', () => {
  it('is the dm_did cookie when the browser has one', async () => {
    const get = jar().mockResolvedValue({ name: 'dm_did', value: 'web-device-id' } as never);
    const payload = await buildPayload(report);
    expect(payload.deviceId).toBe('web-device-id');
    expect(get).toHaveBeenCalledWith({ url: 'https://dmarket.com/', name: 'dm_did' });
    expect(await storedInstallId()).toBeUndefined(); // no install id minted while the cookie answers
  });

  it('falls back to the stored install id without the cookie, and keeps it', async () => {
    const payload = await buildPayload(report);
    expect(payload.deviceId).toBe(await storedInstallId());
    expect((await buildPayload(report)).deviceId).toBe(payload.deviceId); // stable across reports
  });

  it('falls back to the install id when the cookie read throws', async () => {
    jar().mockRejectedValue(new Error('no host permission'));
    expect((await buildPayload(report)).deviceId).toBe(await storedInstallId());
  });

  it('is a new install id after reporting is switched off and back on', async () => {
    const before = (await buildPayload(report)).deviceId;

    await setReportingEnabledByUser(false);
    expect(await storedInstallId()).toBeUndefined();

    await setReportingEnabledByUser(true);
    const after = (await buildPayload(report)).deviceId;
    expect(after).not.toBe(before);
    expect(after).toBe(await storedInstallId());
  });
});

describe('appVersion', () => {
  it('carries version_name, so two betas of one numeric version stay distinct', async () => {
    vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({
      manifest_version: 3,
      name: 'test',
      version: '1.0.6',
      version_name: '1.0.6-beta.2',
    });
    expect((await buildPayload(report)).appVersion).toMatch(/^1\.0\.6-beta\.2\+/);
  });
});
