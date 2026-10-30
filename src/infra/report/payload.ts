// The wire payload. **Service-worker only** — it reads cookies and stamps the build id, and keeping
// it out of the page bundles is also what stops `@/core/tracker` (and with it the ~1.2 MB core) from being
// pulled into the popup and the content scripts.
//
// Shape is the DMarket frontend's collector payload verbatim (their
// libs/dmarket/util/ng-analytics/src/lib/analytics-collector.service.ts), so extension rows sit in the same
// ClickHouse table as web rows with no schema change beyond one new `source` value.

import { contextUrl, type ReportContext } from '@/infra/report/describe';
import type { Diag } from '@/infra/report/diag';
import { INSTALL_ID_KEY } from '@/infra/report/keys';
import { extensionVersion } from '@/util/extensionVersion';

/** The `source` value the collector's worker gained for us. One value for all extension traffic. */
const REPORT_SOURCE = 'p2p-extension';

/** The frontend's first-party analytics device id, on dmarket.com. Not HttpOnly — set by their own JS. */
const DEVICE_ID_COOKIE = 'dm_did';
const DEVICE_ID_COOKIE_URL = 'https://dmarket.com/';

async function resolveDeviceId(): Promise<string> {
  try {
    const cookie = await browser.cookies.get({ url: DEVICE_ID_COOKIE_URL, name: DEVICE_ID_COOKIE });
    if (cookie?.value) return cookie.value;
  } catch {
    /* no host permission, or the cookie store is unavailable — fall through to the install id */
  }
  return getInstallId();
}

/**
 * Exactly the frontend's error payload, every field listed in the popup's disclosure
 * (src/ui/popup/ErrorReportingToggle.tsx) — a field added here must be added there too.
 *
 * `deviceId` is the frontend's `dm_did` cookie when the browser has one, so extension rows collate with the
 * same browser's web rows — the collector's owner requires it, as with the Snowplow pipeline it replaced.
 * Without the cookie it is our own random install id ({@link getInstallId}), which switching reporting
 * off erases.
 *
 * Deliberately NOT sent, and not to be added without revisiting the store disclosures:
 * - `userId` (`dm-trade-userId`): an account identifier makes every report personally identifying, which
 *   puts it under Chrome's prominent-disclosure rule and AMO's explicit-opt-in rule.
 * - the core's own `device_id`: the marketplace's identity key, flagged sensitive in the storage inspector,
 *   and the page bridge already refuses to expose it.
 */
export interface ReportPayload {
  type: 'error';
  message: string;
  stack: string;
  deviceId: string;
  userAgent: string;
  url: string;
  timestamp: string;
  source: typeof REPORT_SOURCE;
  appVersion: string;
  /**
   * Allowlisted diagnostics of a failed notary proof (src/infra/report/diag.ts): stage, timings, byte counts,
   * thread count, cross-origin isolation, CPU core count, prover build. `metadata` is the collector's one
   * free-form JSON field, wired through to ClickHouse for errors as well as events; a field outside its
   * schema would not be. `DIAG_PLACEMENT` folds it into `message` instead.
   */
  metadata?: Diag;
}

/**
 * Our install id, minted once. Serialised through the outbox's storage chain by the caller, so two
 * concurrent reports cannot mint two ids (the pattern in src/infra/remoteConfig.ts can, and does).
 *
 * Its teardown counterpart lives in src/infra/report/consent.ts, which erases {@link DURABLE_KEYS} in
 * one batch.
 */
export async function getInstallId(): Promise<string> {
  try {
    const stored = (await browser.storage.local.get(INSTALL_ID_KEY))[INSTALL_ID_KEY];
    if (typeof stored === 'string' && stored) return stored;
    const minted = crypto.randomUUID();
    await browser.storage.local.set({ [INSTALL_ID_KEY]: minted });
    return minted;
  } catch {
    return 'unknown';
  }
}

export async function buildPayload(report: {
  context: ReportContext;
  message: string;
  stack: string | null;
  timestamp: string;
  diag?: Diag;
}): Promise<ReportPayload> {
  return {
    type: 'error',
    message: report.message,
    // The frontend's fallback string, so a missing stack reads identically in both pipelines.
    stack: report.stack ?? 'Stacktrace not available',
    deviceId: await resolveDeviceId(),
    userAgent: navigator.userAgent,
    url: contextUrl(report.context),
    timestamp: report.timestamp,
    source: REPORT_SOURCE,
    // `version_name` when present, so two betas of one numeric version stay distinguishable.
    appVersion: `${extensionVersion()}+${__BUILD_ID__}`,
    ...(report.diag !== undefined ? { metadata: report.diag } : {}),
  };
}
