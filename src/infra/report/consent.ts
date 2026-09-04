// The user's opt-out for crash reporting, and the Firefox platform grant that sits alongside it.
//
// Its own module so the popup's toggle does not have to import the outbox (the sender, the queue and the
// settings overlay) just to read one boolean — and so the outbox and the UI cannot drift on what "enabled"
// means.

// Default-on is what makes this opt-out rather than opt-in, which both stores allow for diagnostic data
// provided the user can turn it off.
import { DURABLE_KEYS, ENABLED_KEY } from '@/infra/report/keys';

/** Whether the user has opted out. */
export async function isReportingEnabledByUser(): Promise<boolean> {
  try {
    return (await browser.storage.local.get(ENABLED_KEY))[ENABLED_KEY] !== false;
  } catch {
    return true;
  }
}

/**
 * Record the user's choice. Turning it OFF also discards everything durable the reporter holds — the queued
 * reports, the daily counters, and the install id — so "off" means nothing about it is left on the machine,
 * not merely that nothing new is sent.
 */
export async function setReportingEnabledByUser(enabled: boolean): Promise<void> {
  try {
    await browser.storage.local.set({ [ENABLED_KEY]: enabled });
  } catch {
    /* unwritable storage — the default (on) stands; nothing here is worth failing a click over */
    return;
  }
  if (enabled) return;
  try {
    await browser.storage.local.remove([...DURABLE_KEYS]);
  } catch {
    /* ignore — a flush with reporting disabled drops the backlog anyway */
  }
}

/**
 * Whether the platform permits data collection at all.
 *
 * Firefox gates it on the `technicalAndInteraction` data-collection permission, which the manifest declares
 * `optional` and which is therefore **not granted by default** — so on Firefox reporting is effectively
 * opt-in, and this returns false until the user accepts.
 *
 * Feature-detected through `permissions.getAll()`, deliberately NOT
 * `permissions.contains({ data_collection: … })`: that throws a schema error on any Firefox predating the
 * key, and the manifest's `strict_min_version` is the only thing keeping us above it. Chrome has no
 * equivalent permission, so it is always true there.
 */
export async function hasDataCollectionGrant(): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return true;
  try {
    const all = (await browser.permissions.getAll()) as { data_collection?: string[] };
    if (!('data_collection' in all)) return false; // no consent UI on this Firefox → do not send
    return all.data_collection?.includes('technicalAndInteraction') === true;
  } catch {
    return false;
  }
}

/** Request the Firefox data-collection permission. **Must** be called from a user gesture. */
export async function requestDataCollectionGrant(): Promise<boolean> {
  if (!import.meta.env.FIREFOX) return true;
  try {
    // `data_collection` is not in the WebExtension typings yet (Firefox 140+), hence the cast.
    const request = browser.permissions.request as unknown as (p: unknown) => Promise<boolean>;
    return await request({ data_collection: ['technicalAndInteraction'] });
  } catch {
    return false;
  }
}
