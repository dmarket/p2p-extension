// What goes into the local activity log (src/infra/diag/store.ts). Service worker only: it is the one realm
// that sees the core's lifecycle stream, the proving realm's relayed lines and the state mirrors.
//
// The log is exported by the user's own hand and read by support, so identifiers stay readable — Steam ids,
// deal, offer and trade ids are what a stuck deal is diagnosed from — and credentials never land: every string
// passes `redactSecrets`, a field whose NAME is a credential is blanked whatever its value looks like, and
// nothing nested is kept, so a frame shape the core adds later cannot smuggle a payload in. Request and
// response bodies, headers and cookies are not recorded at all: production has no fetch wrap
// (scripts/verify-build.mjs refuses one).
//
// Every entry point is fire-and-forget and never throws: two of them run synchronously inside the core's
// coroutine, where a throw aborts the cycle.

import type { ProofSnapshot } from '@/core/notary-snapshot';
import { appendDiag, type DiagEntry, type DiagValue } from '@/infra/diag/store';
import { isCredentialName, redactSecrets, REDACTED } from '@/util/redact';

/** Longest kept field value; a lifecycle field is a code, a count or an id, never a payload. */
const MAX_FIELD_CHARS = 400;

/** Longest kept narration line. A proof's summary line runs ~450 characters. */
const MAX_NOTE_CHARS = 1_000;

/** The dev console's tag for the same lines (`NOTARY_TRACE_EVENT`), spelled here because notary-trace imports this module. */
const NOTARY_EVENT = 'NotaryProof';

/**
 * Fields that name the OTHER party of a trade: not the user's to hand to support (R6). Dropped at write, and
 * again by the export. `accountid_other` is Steam's own name for it, should a frame ever carry one.
 */
export const COUNTERPARTY_FIELDS: ReadonlySet<string> = new Set(['partnerSteamId', 'accountid_other']);

export type DiagFields = Record<string, DiagValue>;

/** Primitives only, scrubbed and capped; `omit` drops named fields outright. `undefined` when nothing is left. */
export function sanitizeFields(obj: object, omit?: ReadonlySet<string>): DiagFields | undefined {
  const out: DiagFields = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (omit?.has(key)) continue;
    // The key goes along because it is not in the text: a split-off `dealId` value has nothing in front of it
    // to mark it as an id (see redactSecrets).
    if (typeof value === 'string') out[key] = isCredentialName(key) ? REDACTED : redactSecrets(value, key).slice(0, MAX_FIELD_CHARS);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A core lifecycle frame reduced to its tag and primitive fields, or `null` when it has no usable tag (the
 * core↔host contract broke, which background.ts reports on its own). Shared with the dev console's log.
 */
export function sanitizeFrame(frame: unknown, omit?: ReadonlySet<string>): { event: string; fields?: DiagFields } | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const { event, ...rest } = frame as Record<string, unknown>;
  if (typeof event !== 'string' || event === '') return null;
  return { event, fields: sanitizeFields(rest, omit) };
}

/** How often a socket that moved nothing keeps a PROGRESS line. A moving one keeps every tick (every 5 s). */
export const PROGRESS_IDLE_EVERY_MS = 30_000;

const PROGRESS = /\b(ws#\d+) PROGRESS\b/;
/** The per-tick deltas, `(+1.2MB)`, sent then recv. */
const DELTA = /\(\+([^)]*)\)/g;

/**
 * Whether a notary line is worth a slot. Everything is, except a `ws#N PROGRESS` tick on a socket that moved
 * no byte since the last tick and already had a line within {@link PROGRESS_IDLE_EVERY_MS}. A stall is still
 * visible — one line every 30 s says the socket was alive and silent — without a 180 s hang eating 72 slots.
 * Records the kept tick in `last`.
 */
export function keepNotaryLine(last: Map<string, number>, note: string, proofId: string | undefined, now: number): boolean {
  const tick = PROGRESS.exec(note);
  if (!tick) return true;
  const deltas = [...note.matchAll(DELTA)].map((d) => d[1]);
  // A line whose deltas cannot be read counts as moving: a format change must cost slots, not evidence.
  const moving = deltas.length === 0 || deltas.some((d) => d !== '0B');
  const key = `${proofId ?? ''}|${tick[1]}`;
  const prev = last.get(key);
  if (!moving && prev !== undefined && now - prev < PROGRESS_IDLE_EVERY_MS) return false;
  // shortcut: one entry per socket a worker ever opened; cleared wholesale past 64, which costs at most one
  // extra line per live socket. Upgrade to per-socket eviction if a worker ever holds that many at once.
  if (last.size > 64) last.clear();
  last.set(key, now);
  return true;
}

const progressKept = new Map<string, number>();

function write(entry: DiagEntry): void {
  void appendDiag(entry, entry.ts).catch(() => {
    /* a log that cannot be written must not surface into the caller */
  });
}

/** One core lifecycle frame, already parsed. */
export function recordLifecycle(frame: unknown): void {
  const kept = sanitizeFrame(frame, COUNTERPARTY_FIELDS);
  if (kept) write({ ts: Date.now(), section: 'events', ...kept });
}

/** A host-side fact on the timeline: a core start, a blocking-reason or activation change. */
export function recordState(event: string, fields: DiagFields): void {
  write({ ts: Date.now(), section: 'events', event, fields: sanitizeFields(fields) });
}

/** One line of the proof path — the service worker's own, or one relayed from the proving realm. */
export function recordNotary(note: string, level?: DiagEntry['level'], proofId?: string, snapshot?: ProofSnapshot): void {
  const ts = Date.now();
  if (!keepNotaryLine(progressKept, note, proofId, ts)) return;
  write({
    ts,
    section: 'notary',
    event: NOTARY_EVENT,
    level,
    note: redactSecrets(note).slice(0, MAX_NOTE_CHARS),
    fields: sanitizeFields({ proofId, ...snapshot }),
  });
}
