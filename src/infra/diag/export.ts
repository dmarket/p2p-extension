// The support export: the local activity log (store.ts) plus a header saying which build and which accounts
// it is about, as one JSON file the user saves or copies by hand from the popup's Help tab and sends to support
// themselves. One builder for both paths — export.html's "Save file" and the popup's "Copy to clipboard" — so
// the two can never disagree about what the file contains.
//
// What may go in follows the consent text in src/ui/popup/ExportLogView.tsx: the user's own Steam id, DMarket
// account id and deal/offer ids, because support diagnoses a stuck deal from them. Never a credential, and
// never the other party of a trade (R6). The entries were scrubbed when they were written; they are scrubbed
// again here, with the same rules, because this is where they leave the extension.

import { resolveDmarketUrl } from '@/config/dmarketSite';
import { getMarketplaceCookieName, loadSettings } from '@/config/settings';
import { COUNTERPARTY_FIELDS, sanitizeFields } from '@/infra/diag/record';
import { readDiagLog, type DiagEntry } from '@/infra/diag/store';
import { INSTALL_ID_KEY } from '@/infra/report/keys';
import { getActiveTrackingCount } from '@/state/activeCount';
import { isActivated } from '@/state/activation';
import { getBlockingReason, getLinkedSteamId } from '@/state/blocking';
import { redactSecrets } from '@/util/redact';

export interface DiagExportHeader {
  version: string;
  versionName?: string;
  /** `<git sha>+core<version>`. */
  buildId: string;
  proverBuild: string;
  userAgent: string;
  exportedAt: string;
  blockingReason: string;
  activated: boolean;
  /** Deals the tracker was watching at export time. */
  activeDeals: number;
  /** The id error reports carry as `deviceId`. Absent when no report was ever sent, or reporting is off. */
  installId?: string;
  steamId64?: string;
  dmarketUserId?: string;
}

export interface DiagExport {
  header: DiagExportHeader;
  entries: DiagEntry[];
}

/** The core's storage key for the scraped Steam session — a JSON string holding a LIVE token next to the id. */
const STEAM_CREDENTIAL_KEY = 'steam_credential';

const STEAM_ID64 = /^\d{17}$/;

/** Shape check only: the id is written into the file verbatim, so nothing else may ride in this slot. */
const ACCOUNT_ID = /^[\w-]{1,64}$/;

/** The `steam_id` of the core's stored credential. The token beside it is never read out of the parsed object. */
export function steamIdFromCredential(raw: unknown): string | undefined {
  try {
    const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const id = (parsed as { steam_id?: unknown } | null | undefined)?.steam_id;
    return typeof id === 'string' && STEAM_ID64.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The DMarket account id from the access token's payload — `attributes.account_id`, the claim dmarket.com
 * itself reads for its user id (frontend auth-facade.service.ts). Decoded locally, signature unchecked (we
 * only label a file with it); the token itself goes nowhere.
 */
export function accountIdFromAccessToken(token: string): string | undefined {
  try {
    const body = token.split('.')[1];
    if (!body) return undefined;
    const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as {
      attributes?: { account_id?: unknown };
    };
    const id = payload.attributes?.account_id;
    return typeof id === 'string' && ACCOUNT_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

async function readSteamId(): Promise<string | undefined> {
  const stored = await browser.storage.local.get(STEAM_CREDENTIAL_KEY);
  return steamIdFromCredential(stored[STEAM_CREDENTIAL_KEY]) ?? (await getLinkedSteamId());
}

/** Absent when signed out, or when the cookie cannot be read here — the file is still worth having without it. */
async function readDmarketUserId(): Promise<string | undefined> {
  try {
    const cookie = await browser.cookies.get({ url: await resolveDmarketUrl(), name: getMarketplaceCookieName() });
    return cookie ? accountIdFromAccessToken(decodeURIComponent(cookie.value)) : undefined;
  } catch {
    return undefined;
  }
}

/** Read, never minted: an id made here would link to no report, and with reporting off it would undo the opt-out's erase. */
async function readInstallId(): Promise<string | undefined> {
  const stored = (await browser.storage.local.get(INSTALL_ID_KEY))[INSTALL_ID_KEY];
  return typeof stored === 'string' && stored ? stored : undefined;
}

/** The second pass over a stored entry: known keys only, every string re-scrubbed, counterparty fields dropped. */
function scrubEntry({ seq, ts, section, event, level, note, fields }: DiagEntry): DiagEntry {
  return {
    seq,
    ts,
    section,
    event: redactSecrets(event),
    level,
    note: note === undefined ? undefined : redactSecrets(note),
    fields: fields && sanitizeFields(fields, COUNTERPARTY_FIELDS),
  };
}

export async function buildDiagExport(now: Date = new Date()): Promise<DiagExport> {
  await loadSettings(); // the cookie name and the site URL may be remote-config overrides
  const manifest = browser.runtime.getManifest();
  const [blockingReason, activated, activeDeals, installId, steamId64, dmarketUserId, entries] = await Promise.all([
    getBlockingReason(),
    isActivated(),
    getActiveTrackingCount(),
    readInstallId(),
    readSteamId(),
    readDmarketUserId(),
    readDiagLog(),
  ]);
  return {
    header: {
      version: manifest.version,
      versionName: manifest.version_name,
      buildId: __BUILD_ID__,
      proverBuild: __PROVER_BUILD__,
      userAgent: navigator.userAgent,
      exportedAt: now.toISOString(),
      blockingReason,
      activated,
      activeDeals,
      installId,
      steamId64,
      dmarketUserId,
    },
    entries: entries.map(scrubEntry),
  };
}

/** Header pretty-printed, one entry per line: readable in a text editor, and greppable line by line. */
export function serializeDiagExport({ header, entries }: DiagExport): string {
  const head = JSON.stringify(header, null, 2).replace(/\n/g, '\n  ');
  const rows = entries.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n');
  return `{\n  "header": ${head},\n  "entries": [${rows ? `\n${rows}\n  ` : ''}]\n}\n`;
}

/** `dmarket-trade-tracker-log-2026-10-30T12-34-56.789Z.json` — colons are not allowed in Windows file names. */
export const exportFileName = (exportedAt: string): string =>
  `dmarket-trade-tracker-log-${exportedAt.replace(/:/g, '-')}.json`;
