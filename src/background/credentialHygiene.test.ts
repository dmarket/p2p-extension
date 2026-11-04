import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  DM_MISSING_PURGE_MS,
  STEAM_CREDENTIAL_KEY,
  clearSteamCredential,
  purgeCredentialOnLongDmSignOut,
} from '@/background/credentialHygiene';
import { withdrawCoreState } from '@/background/withdraw';
import { flushMacrotasks } from '@/testing/stubs';

const T0 = 1_800_000_000_000;
const ROW = JSON.stringify({ token: 'x', steam_id: '1', expires_at_ms: 1 });
// The current core keeps the row in storage.session; an older core left it in storage.local.
const seed = async () => {
  await fakeBrowser.storage.session.set({ [STEAM_CREDENTIAL_KEY]: ROW });
  await fakeBrowser.storage.local.set({ [STEAM_CREDENTIAL_KEY]: ROW, 'tracker.blockingReason': 'STEAM_ACCOUNT_MISMATCH' });
};
const credentialPresent = async () =>
  (await fakeBrowser.storage.session.get(STEAM_CREDENTIAL_KEY))[STEAM_CREDENTIAL_KEY] !== undefined ||
  (await fakeBrowser.storage.local.get(STEAM_CREDENTIAL_KEY))[STEAM_CREDENTIAL_KEY] !== undefined;

describe('clearSteamCredential', () => {
  it('removes the row from storage.session and the legacy copy from storage.local', async () => {
    await seed();
    await clearSteamCredential();
    expect(await fakeBrowser.storage.session.get(STEAM_CREDENTIAL_KEY)).toEqual({});
    expect(await fakeBrowser.storage.local.get(STEAM_CREDENTIAL_KEY)).toEqual({});
  });
});

describe('withdrawCoreState (deactivation)', () => {
  it('removes the stored Steam credential along with the mirrors', async () => {
    await seed();

    withdrawCoreState();
    await flushMacrotasks();

    expect(await credentialPresent()).toBe(false);
    expect((await fakeBrowser.storage.local.get('tracker.blockingReason'))['tracker.blockingReason']).toBe('NONE');
  });

  it('is harmless when there is no credential', async () => {
    withdrawCoreState();
    await flushMacrotasks();

    expect(await credentialPresent()).toBe(false);
  });
});

describe('purgeCredentialOnLongDmSignOut', () => {
  it('keeps the credential until the DMarket session has been missing for an hour', async () => {
    await seed();

    await purgeCredentialOnLongDmSignOut('DM_SESSION_MISSING', T0);
    await purgeCredentialOnLongDmSignOut('DM_SESSION_MISSING', T0 + DM_MISSING_PURGE_MS - 1);
    expect(await credentialPresent()).toBe(true);

    await purgeCredentialOnLongDmSignOut('DM_SESSION_MISSING', T0 + DM_MISSING_PURGE_MS);
    expect(await credentialPresent()).toBe(false);
  });

  it('restarts the hour when the session comes back in between', async () => {
    await seed();

    await purgeCredentialOnLongDmSignOut('DM_SESSION_MISSING', T0);
    await purgeCredentialOnLongDmSignOut('NONE', T0 + 1000);
    await purgeCredentialOnLongDmSignOut('DM_SESSION_MISSING', T0 + DM_MISSING_PURGE_MS);
    expect(await credentialPresent()).toBe(true);
  });

  it('never purges for any other reason', async () => {
    await seed();

    await purgeCredentialOnLongDmSignOut('STEAM_SESSION_MISSING', T0);
    await purgeCredentialOnLongDmSignOut('STEAM_SESSION_MISSING', T0 + 10 * DM_MISSING_PURGE_MS);
    expect(await credentialPresent()).toBe(true);
  });
});
