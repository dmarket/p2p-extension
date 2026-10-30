import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { INSTALL_ID_KEY } from '@/infra/report/keys';
import { buildPayload } from '@/infra/report/payload';
import { setReportingEnabledByUser } from '@/infra/report/consent';
import { stubManifest } from '@/testing/stubs';

// The payload's identity contract: `deviceId` is our own install id and nothing the browser holds for
// dmarket.com. The store listing promises reports that cannot be tied to a web session, so the cookie
// must not even be READ — the spy below holds a live `dm_did` to make a read observable.

const report = { context: 'background' as const, message: 'boom', stack: null, timestamp: '2026-10-30T00:00:00.000Z' };

const storedInstallId = async (): Promise<unknown> =>
  (await browser.storage.local.get(INSTALL_ID_KEY))[INSTALL_ID_KEY];

let cookiesGet: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  stubManifest([]);
  // fake-browser does not implement cookies.get; this is a jar where the frontend's analytics id exists.
  cookiesGet = vi
    .spyOn(fakeBrowser.cookies, 'get')
    .mockResolvedValue({ name: 'dm_did', value: 'web-device-id' } as never);
});

describe('deviceId', () => {
  it('never reads a cookie, even when dm_did is present', async () => {
    const payload = await buildPayload(report);
    expect(cookiesGet).not.toHaveBeenCalled();
    expect(payload.deviceId).not.toBe('web-device-id');
  });

  it('is the stored install id', async () => {
    const payload = await buildPayload(report);
    expect(payload.deviceId).toBe(await storedInstallId());
    expect((await buildPayload(report)).deviceId).toBe(payload.deviceId); // stable across reports
  });

  it('is a new id after reporting is switched off and back on', async () => {
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
