// Turning an unknown thrown value into a report-safe description. Core-free on purpose: the popup and both
// content scripts import this, and pulling in `@/core/tracker` would drag the ~1.2 MB compiled core into
// their bundles.

import { redactText, redactAndCap } from '@/util/redact';

/** FE parity: `MESSAGE_MAX_LENGTH` / `STACK_MAX_LENGTH` in their analytics-collector.service.ts. */
export const MESSAGE_MAX = 2048;
export const STACK_MAX = 8192;

/** Where the error happened. Encoded into the payload's `url`; `core` additionally prefixes `message`. */
export type ReportContext = 'background' | 'popup' | 'content/steam-tradeoffers' | 'content/dmarket-bridge';

/**
 * The `url` field. Never `location.href`: the Steam content script matches `/profiles/*​/tradeoffers*`, so
 * the real URL embeds the user's SteamID64, and a raw page URL is "browsing activity" to both stores.
 */
export function contextUrl(context: ReportContext): string {
  return `ext://${context}`;
}

export interface Described {
  /** Already redacted and capped; prefixed with `core: ` when the failure came out of the tracker core. */
  message: string;
  /** Already redacted and capped, or null. */
  stack: string | null;
  /** Stable grouping key over the normalised message — readable, so it is debuggable in the inspector. */
  fingerprint: string;
  /** True when the top own frame is in the core bundle, or the caller said so. */
  fromCore: boolean;
}

/** Frames from the compiled Kotlin/JS core. Its bundle is inlined into background.js, so match its symbols. */
const CORE_FRAME = /p2p-tracker-core|kotlin|ktor|coroutines/i;

/**
 * Extract a message from an unknown thrown value. Mirrors the FE's `#extractMessage` ladder
 * (error-handler.service.ts) so the two pipelines agree on what "the message" is.
 */
function extractMessage(error: unknown): string {
  if (error == null) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.name || 'Unknown error';
  if (typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  // `String(error)` on an object with no useful `toString` yields '[object Object]', which is the accepted
  // floor for this function rather than a defect: it must always return a string and never throw, every
  // better source has already been tried above, and enumerating own properties is forbidden here (see the
  // note on readStack — that is how a Ktor response body leaks into a report).
  /* eslint-disable @typescript-eslint/no-base-to-string */
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
  /* eslint-enable @typescript-eslint/no-base-to-string */
}

/**
 * Read `.stack` only. **Never** enumerate own properties and never walk `cause` by hand: Kotlin/JS keeps a
 * Ktor exception's full message in a mangled own field (`p4r_1`), a `ResponseException` retains the whole
 * `HttpResponse` as an own property, and `_suppressed` is enumerable — so `JSON.stringify(error)` leaks
 * what `.message` does not. (Kotlin's own `stackTraceToString`, which the core hands `reportError`, already
 * folds in `Caused by:` / `Suppressed:` lines, and those arrive inside `.stack` as text.)
 */
function extractStack(error: unknown): string | null {
  if (error instanceof Error && typeof error.stack === 'string' && error.stack) return error.stack;
  if (typeof error === 'object' && error !== null && 'stack' in error) {
    const s = (error as { stack?: unknown }).stack;
    if (typeof s === 'string' && s) return s;
  }
  return null;
}

/**
 * The **allowlist** for a core-origin failure, and the reason this module exists.
 *
 * A Kotlin/JS exception message can embed an entire HTTP response body: kotlinx-serialization appends the
 * decoded input, and Kotlin data classes print every field. The core now sanitizes all of that at the
 * source, but the generated `.d.mts` types its whole surface as opaque strings — a core that grows a field
 * would ship it here with no compile error on either side. So a core-origin message is reduced to a shape
 * we choose rather than filtered with patterns we hope are complete: the exception class, the message up to
 * its first delimiter, and an HTTP status if one is parseable.
 *
 * Deep debugging is unaffected — the dev console's session log still has the full local traffic.
 */
function allowlistCoreMessage(raw: string): string {
  const status = /\b([1-5]\d\d)\b/.exec(raw)?.[1];
  // Kotlin renders `ClassName: message`; keep the class, then cut at the first delimiter that could
  // introduce interpolated data (a paren, a quote, a brace, or a second colon).
  const [, cls, rest] = /^([A-Za-z_$][\w$.]*(?:Exception|Error|Throwable))\s*:\s*([\s\S]*)$/.exec(raw) ?? [];
  const head = (rest ?? raw).split(/[("'{[\n]/)[0]!.trim().slice(0, 120);
  return [cls, head || null, status ? `status=${status}` : null].filter(Boolean).join(' ');
}

/** Reduce a stack to frame locations, dropping any interleaved message text a `Caused by:` line carries. */
function allowlistCoreStack(stack: string): string {
  return stack
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (/^(at\s|ext:\/\/|https?:\/\/)/.test(trimmed)) return trimmed;
      // A header or a `Caused by:` line: keep only the exception class name.
      const cls = /([A-Za-z_$][\w$.]*(?:Exception|Error|Throwable))/.exec(trimmed)?.[1];
      return cls ? `${trimmed.startsWith('Caused by') ? 'Caused by: ' : ''}${cls}` : null;
    })
    .filter((l): l is string => l !== null)
    .join('\n');
}

/**
 * Strip the parts of a message that vary between otherwise-identical failures, so the fingerprint groups
 * them. Runs on the ALREADY-REDACTED text, so `<redacted>`/`<steamid>` markers are already in place.
 */
function normalizeForFingerprint(message: string): string {
  return message
    .replace(/\b\d+\b/g, 'N')
    .replace(/\b[0-9a-f]{8,}\b/gi, 'H')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/**
 * Describe a thrown value for reporting: redacted, capped, classified, and fingerprinted.
 *
 * @param forceCore treat as core-origin regardless of the stack — for a failure caught around a
 *   `Tracker.*` call, where the stack may not name a core frame at all.
 */
export function describeError(error: unknown, context: ReportContext, forceCore = false): Described {
  const rawMessage = extractMessage(error);
  const rawStack = extractStack(error);
  const fromCore = forceCore || (rawStack !== null && CORE_FRAME.test(rawStack));

  // Redaction always runs, on both layers, and always BEFORE the cap.
  const message = fromCore
    ? redactAndCap(allowlistCoreMessage(rawMessage), MESSAGE_MAX)
    : redactAndCap(rawMessage, MESSAGE_MAX);
  const stack =
    rawStack === null
      ? null
      : fromCore
        ? redactAndCap(allowlistCoreStack(rawStack), STACK_MAX)
        : redactAndCap(rawStack, STACK_MAX);

  return {
    message: fromCore ? `core: ${message}` : message,
    stack,
    fingerprint: `${context}|${normalizeForFingerprint(redactText(message))}`,
    fromCore,
  };
}
