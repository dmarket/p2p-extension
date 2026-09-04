// The crash reporter's storage keys, in one place.
//
// They live in their own core-free module because the opt-out path needs to erase all of them at once
// while the modules that OWN them cannot be imported from it: `setReportingEnabledByUser` runs in the
// popup, and importing the outbox (the sender, the settings overlay) or the payload builder (which reads
// cookies and pulls in describe.ts) just to name a key would drag service-worker-only code into a page
// bundle. So the keys were re-typed as literals there, which is exactly how a rename in an owner would
// have silently stopped erasing one of them — the guarantee `consent.ts` documents.

/** Absent means ON — see src/infra/report/consent.ts. */
export const ENABLED_KEY = 'report.enabled';

/** Reports written but not yet accepted by the collector — see src/infra/report/outbox.ts. */
export const QUEUE_KEY = 'report.queue';

/** Rate-limiting state (day, per-bucket counts, cooldowns) — see src/infra/report/outbox.ts. */
export const POLICY_KEY = 'report.policy';

/** Per-install UUID used as `deviceId` when the dmarket `dm_did` cookie is absent — see payload.ts. */
export const INSTALL_ID_KEY = 'report.install_id';

/**
 * Everything durable the reporter holds, minus the opt-out flag itself. Turning reporting off removes
 * exactly this list, so "off" means nothing about it is left on the machine.
 */
export const DURABLE_KEYS = [QUEUE_KEY, POLICY_KEY, INSTALL_ID_KEY] as const;
