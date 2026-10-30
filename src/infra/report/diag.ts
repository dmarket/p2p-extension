// Structured diagnostics for a crash report, sent as the collector's `metadata` field. Core-free, like the rest
// of the report surface.
//
// Built for the notary proof path: a failed proof's report used to be one `reason` line, which cannot tell a
// stall in MPC preprocessing from a slow uplink from a dropped notary. The numbers that can live in the prover
// worker's snapshot (src/core/notary-snapshot.ts); this module decides which of them may leave the machine.
//
// It is an ALLOWLIST, keyed and typed. A field not named below is dropped, a value of the wrong type is
// dropped, a string must match its pattern after redaction. So nothing can ride along that was not chosen
// here: no id (deal, offer, trade, steamid, notary session), no URL, no free text.

import { redactText } from '@/util/redact';

export type DiagValue = number | boolean | string;
export type Diag = Readonly<Record<string, DiagValue>>;

/** `int`: a safe integer ≥ 0. `num`: a finite number ≥ 0. A RegExp: a string matching it after `redactText`. */
type FieldType = 'int' | 'num' | 'bool' | RegExp;

const INT = 'int';

/**
 * Every field `diag` may carry. Adding one here is adding it to what the extension sends: the popup's
 * disclosure (src/ui/popup/ErrorReportingToggle.tsx) must still describe it.
 */
const FIELDS: Readonly<Record<string, FieldType>> = {
  /** How the proof ended on the service worker's side. */
  outcome: /^(timeout|failed)$/,
  /** Random per attempt, minted on the client; never handed to the notary. Correlates a report with an export. */
  proofId: /^[0-9a-f]{8}$/,
  /** Service-worker wall clock from the delegate's entry to the failure. */
  durationMs: INT,
  stage: /^[A-Z][A-Z0-9_]{0,31}$/,
  stageSec: 'num',
  elapsedMs: INT,
  notarySent: INT,
  notaryRecv: INT,
  notaryBuffered: INT,
  notaryIdleMs: INT,
  notaryClose: INT,
  proxySent: INT,
  proxyRecv: INT,
  proxyBuffered: INT,
  proxyIdleMs: INT,
  proxyClose: INT,
  concurrent: INT,
  threadCount: INT,
  cores: INT,
  isolated: 'bool',
  freshWorker: 'bool',
  proverBuild: /^[\w.+-]{1,64}$/,
};

/** Serialised size cap. The full field set is ~600 bytes; this guards a future field, not today's. */
export const DIAG_MAX_BYTES = 2048;

function accept(type: FieldType, value: unknown): DiagValue | undefined {
  switch (type) {
    case 'int':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    case 'num':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    case 'bool':
      return typeof value === 'boolean' ? value : undefined;
    default: {
      if (typeof value !== 'string') return undefined;
      const scrubbed = redactText(value);
      return type.test(scrubbed) ? scrubbed : undefined;
    }
  }
}

/**
 * The one serialisation: allowlisted, flat, primitive, capped. `undefined` when nothing survives, so a report
 * carries either a real `diag` or none. Never throws — it runs on the crash path.
 */
export function serializeDiag(raw: unknown): Diag | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: Record<string, DiagValue> = {};
  for (const [key, type] of Object.entries(FIELDS)) {
    const value = accept(type, (raw as Record<string, unknown>)[key]);
    if (value === undefined) continue;
    out[key] = value;
    // Over the cap: drop the field that tipped it, keep the rest. Field order is the priority order above.
    if (JSON.stringify(out).length > DIAG_MAX_BYTES) delete out[key];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * R12. `field`: `diag` goes out as the payload's `metadata`, numbers exact — the collector's owner confirmed
 * that field is stored for errors. `suffix`: `diag` folded into the message as ` [diag k=v …]`, numbers
 * bucketed. Flipping this constant is the whole rollback.
 */
export const DIAG_PLACEMENT: 'field' | 'suffix' = 'field';

/**
 * The single point that decides where `diag` goes. `suffix` is appended to the message by the caller, inside
 * the message cap's reserved room (see `redactAndCap`).
 */
export function placeDiag(
  diag: Diag | undefined,
  placement: 'field' | 'suffix' = DIAG_PLACEMENT,
): { field?: Diag; suffix: string } {
  if (diag === undefined) return { suffix: '' };
  if (placement === 'field') return { field: diag, suffix: '' };
  const parts = Object.entries(diag)
    // A per-attempt id makes every message unique, which defeats the point of grouping by message.
    .filter(([key]) => key !== 'proofId')
    .map(([key, value]) => `${key}=${typeof value === 'number' ? bucket(value) : String(value)}`);
  return { suffix: parts.length > 0 ? ` [diag ${parts.join(' ')}]` : '' };
}

/** Power-of-two lower bound above 16, so a message stays groupable: `39317479` → `>=33554432`. */
function bucket(n: number): string {
  if (n < 16) return String(Math.floor(n));
  return `>=${2 ** Math.floor(Math.log2(n))}`;
}
