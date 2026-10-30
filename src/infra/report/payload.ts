// The wire payload. **Service-worker only** — it mints the install id and stamps the build id, and keeping
// it out of the page bundles is also what stops `@/core/tracker` (and with it the ~1.2 MB core) from being
// pulled into the popup and the content scripts.
//
// Shape is the DMarket frontend's collector payload verbatim (their
// libs/dmarket/util/ng-analytics/src/lib/analytics-collector.service.ts), so extension rows sit in the same
// ClickHouse table as web rows with no schema change beyond one new `source` value.

import { contextUrl, type ReportContext } from '@/infra/report/describe';
import { INSTALL_ID_KEY } from '@/infra/report/keys';
import { extensionVersion } from '@/util/extensionVersion';

/** The `source` value the collector's worker gained for us. One value for all extension traffic. */
const REPORT_SOURCE = 'p2p-extension';

/**
 * Exactly the frontend's error payload, every field listed in the popup's disclosure
 * (src/ui/popup/ErrorReportingToggle.tsx) — a field added here must be added there too.
 *
 * `deviceId` is our own random install id ({@link getInstallId}), never a dmarket.com cookie: the store
 * listing promises reports that cannot be tied to an account or a web session. It answers "how many
 * installs are affected" and nothing more, and switching reporting off erases it.
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
}): Promise<ReportPayload> {
  return {
    type: 'error',
    message: report.message,
    // The frontend's fallback string, so a missing stack reads identically in both pipelines.
    stack: report.stack ?? 'Stacktrace not available',
    deviceId: await getInstallId(),
    userAgent: navigator.userAgent,
    url: contextUrl(report.context),
    timestamp: report.timestamp,
    source: REPORT_SOURCE,
    // `version_name` when present, so two betas of one numeric version stay distinguishable.
    appVersion: `${extensionVersion()}+${__BUILD_ID__}`,
  };
}
