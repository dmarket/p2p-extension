// The core keeps the scraped Steam web-API token in `storage.session` under a flat key, unencrypted, so it never
// reaches disk (older cores kept it in `storage.local`, and the new vault removes that copy). The core clears it on a Steam sign-out or account switch, but not when
// the extension stops being allowed to track, so these two paths remove it from the host side. Removal is
// safe at any time: the core re-scrapes within one cycle once it runs and the seller is signed in.

import type { BlockingReason } from '@/core/blockingReason';

/** The core's vault key. Owned by the core, so a rename there has to be mirrored here. */
export const STEAM_CREDENTIAL_KEY = 'steam_credential';

const DM_MISSING_SINCE_KEY = 'hygiene.dmSessionMissingSince';

/** How long the DMarket session may stay missing before the Steam token is dropped. */
export const DM_MISSING_PURGE_MS = 60 * 60 * 1000;

/** Idempotent; removing an absent key fires no `storage.onChanged`. `storage.local` holds an older core's copy. */
export async function clearSteamCredential(): Promise<void> {
  await Promise.all([
    browser.storage.session.remove(STEAM_CREDENTIAL_KEY),
    browser.storage.local.remove(STEAM_CREDENTIAL_KEY),
  ]);
}

/** The raw vault row, from `storage.session`, or `storage.local` under an older core. Trusted contexts only. */
export async function readSteamCredential(): Promise<unknown> {
  const session = (await browser.storage.session.get(STEAM_CREDENTIAL_KEY))[STEAM_CREDENTIAL_KEY];
  return session ?? (await browser.storage.local.get(STEAM_CREDENTIAL_KEY))[STEAM_CREDENTIAL_KEY];
}

/**
 * Called with the mirrored reason on every core cycle (the core's alarm tick drives those), so no alarm or
 * permission of our own is needed. Stamps the first cycle that saw `DM_SESSION_MISSING`, drops the stamp
 * as soon as the reason is anything else, and clears the token once the outage has lasted
 * `DM_MISSING_PURGE_MS`. A worker eviction loses nothing: the stamp is in `storage.local`.
 */
export async function purgeCredentialOnLongDmSignOut(reason: BlockingReason, now = Date.now()): Promise<void> {
  if (reason !== 'DM_SESSION_MISSING') {
    await browser.storage.local.remove(DM_MISSING_SINCE_KEY);
    return;
  }
  const stored = await browser.storage.local.get(DM_MISSING_SINCE_KEY);
  const since: unknown = stored[DM_MISSING_SINCE_KEY];
  if (typeof since !== 'number') {
    await browser.storage.local.set({ [DM_MISSING_SINCE_KEY]: now });
    return;
  }
  if (now - since >= DM_MISSING_PURGE_MS) await clearSteamCredential();
}
