// Dev-only network capture: wrap the service worker's global `fetch` so every HTTP call the tracker
// core makes is logged. The core's Ktor JS client funnels ALL traffic through one bare global
// `fetch(input, init)` (node_modules/@dmarket/p2p-tracker-core/ktor-ktor-client-core.mjs; exact line
// tracks the published build), so wrapping the global captures 100% of it — with no core changes, no
// separate debug bundle, and no new permissions.
//
// Captured for local debugging (method, URL, headers, request + response bodies, cookies). It never
// ships to production (guarded by import.meta.env.PROD in background.ts).
//
// Every CREDENTIAL captured is redacted, because the log has a one-click "export" to a JSON file that gets
// pasted into issues and chats. Identifiers are NOT: steamids, device ids, deal ids and ordinary query
// values stay readable, since they are the evidence a session or wrong-account bug is diagnosed from. The
// line is drawn by `redactSecrets` (src/util/redact.ts) — the same module the crash reporter uses, through
// its stricter `redactText` entry point, because a report leaves the machine and this log does not.
//   - a CREDENTIAL cookie's value is described, never disclosed (see describeCookieValue). A Steam cookie
//     jar contains `steamRefresh_steam` — the durable "remember me" credential, valid for ~400 days and
//     enough on its own to mint a full session — and the core is built around never even reading it (see
//     the audit boundary in the core's SteamWebSessionGateway KDoc). Logging it verbatim handed it to
//     anyone the export reached. What the tool needs to debug a session problem is which cookies were
//     attached and when they expire, so that is what is kept: name, flags, value length, and — for a
//     `steamid||jwt` value — the public steamid plus the token's decoded `exp`. Never the token. Every
//     other cookie (`dm_did`, `browserid`, `steamCountry`, …) is shown as sent.
//   - a CREDENTIAL request header is described the same way (see scrubHeaderValue): the header name and any
//     auth scheme stay, the value becomes its length plus the token's decoded `exp`. `Authorization` used
//     to be captured VERBATIM, and the core sends a DMarket access token valid for ~30 days on every API
//     call, so the export handed out a live token; what a session question needs from it is the `exp`.
//     Every other header (`content-type`, `x-request-id`, `user-agent`, …) is routing or content metadata
//     and is shown as sent, with `redactSecrets` over it as a backstop.
//   - the URL, both bodies and any error string go through `redactSecrets`. The RESPONSE body used to be
//     captured verbatim, which meant the `jwt/ajaxrefresh` reply — `nonce`, `auth`, `login_url` — was
//     exportable in full: the same class of hole as the cookie-value one above.
//
// The scrubber lives outside src/debug/ on purpose: this directory is tree-shaken from production, so a
// production module cannot import from it. The dependency therefore runs this way round, which also means
// there is exactly one copy of the rules.

import { appendLog } from '@/debug/sessionLog';
import { recordProofFrame } from '@/debug/proofState';
import { CREDENTIAL_KEYS, findJwt, redactSecrets } from '@/util/redact';
import {
  MAX_LOG_ENTRIES,
  type CommandLogEntry,
  type LifecycleLogEntry,
  type LogEntryBroadcast,
  type NetworkLogEntry,
} from '@/debug/protocol';

const DMARKET_HOST_RE = /(^|\.)dmarket\.com$/i;
const STEAM_HOST_RE = /(^|\.)(steamcommunity\.com|steampowered\.com)$/i;

let installed = false;

/** Wrap `globalThis.fetch` once. Idempotent across worker respawns within one context. */
export function installNetLog(): void {
  if (installed) return;
  installed = true;

  const orig = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function loggedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const started = Date.now();
    const method = requestMethod(input, init);
    const url = requestUrl(input);
    // Skip our own extension-asset loads (icon PNGs etc.) and any non-HTTP(S) request — the log is for
    // the core's dmarket/steam traffic, not the extension's internal resource fetches.
    if (!isHttpUrl(url)) return orig(input, init);
    // IMPORTANT: pass `init` through BY REFERENCE. The core sets `init.signal` from its own
    // AbortController for request timeout / cancellation — spreading or rebuilding it would silently
    // break that. We only READ from it below.
    try {
      const res = await orig(input, init);
      void record({
        started,
        method,
        url,
        init,
        input,
        status: res.type === 'opaque' ? 0 : res.status,
        opaque: res.type === 'opaque',
        // Clone synchronously (before the core consumes the body) and read the text fire-and-forget,
        // so logging never delays the core's cycle.
        responseClone: res.clone(),
        error: null,
      });
      return res;
    } catch (err) {
      void record({
        started,
        method,
        url,
        init,
        input,
        status: null,
        opaque: false,
        responseClone: null,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };
}

/**
 * Append a synthetic command entry (a note from the debug tooling itself, e.g. a force-tick outcome)
 * to the session log and broadcast it live. Same append + broadcast path as captured network entries.
 * Best-effort: logging must never throw into the caller.
 */
export async function logCommand(
  event: string,
  note?: string,
  level?: CommandLogEntry['level'],
): Promise<void> {
  try {
    const entry: CommandLogEntry = { category: 'command', event, note, level };
    const stored = await appendLog(entry, MAX_LOG_ENTRIES, Date.now());
    broadcast({ type: 'debug:log-entry', entry: stored });
  } catch {
    /* logging must never surface into the caller */
  }
}

/** Longest captured field value; a lifecycle field is a code, count or id, never a payload. */
const MAX_FIELD_CHARS = 400;

/**
 * Append a lifecycle event frame from the core to the session log and broadcast it live.
 *
 * This is what makes a cycle that produced no HTTP traffic readable at all — see {@link LifecycleLogEntry}.
 * Only primitives are kept (strings scrubbed and capped, numbers/booleans/null as-is); anything nested is
 * dropped rather than serialised, so a future frame shape cannot smuggle a payload into the log. Anything
 * without a usable `event` tag is ignored: an untagged frame means the core↔host wire contract broke, and
 * background.ts already reports that on its own.
 *
 * Best-effort and never throws: this runs synchronously inside the core's coroutine, where a throw would
 * abort the cycle.
 */
export async function logLifecycle(json: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as Record<string, unknown>;
    const event = frame['event'];
    if (typeof event !== 'string' || event === '') return;
    const fields: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(frame)) {
      if (key === 'event') continue;
      // The key is passed along because it is not in the text here: a lifecycle field arrives already split
      // from its name, so `dealId`'s value has nothing in front of it to mark it as an id (see redactSecrets).
      if (typeof value === 'string') fields[key] = redactSecrets(value, key).slice(0, MAX_FIELD_CHARS);
      else if (typeof value === 'number' || typeof value === 'boolean' || value === null) fields[key] = value;
    }
    const entry: LifecycleLogEntry = { category: 'lifecycle', event, fields: Object.keys(fields).length ? fields : undefined };
    // Mirror the proof-related frames so the console can answer "was a proof attempted?" in the present
    // tense. Fed from here rather than from its own parse: the fields are already scrubbed at this point,
    // and one parse per frame is enough.
    recordProofFrame(event, entry.fields, Date.now());
    const stored = await appendLog(entry, MAX_LOG_ENTRIES, Date.now());
    broadcast({ type: 'debug:log-entry', entry: stored });
  } catch {
    /* logging must never surface into the core's cycle */
  }
}

interface RecordArgs {
  started: number;
  method: string;
  url: string;
  init: RequestInit | undefined;
  input: RequestInfo | URL;
  status: number | null;
  opaque: boolean;
  responseClone: Response | null;
  error: string | null;
}

async function record(args: RecordArgs): Promise<void> {
  try {
    // Redacted like the request body. This was previously captured VERBATIM, so the `jwt/ajaxrefresh`
    // reply (nonce/auth/login_url) and every error envelope were exportable in full — the same class of
    // hole as the cookie-value leak this file's header describes.
    const raw = args.responseClone && !args.opaque ? await safeText(args.responseClone) : null;
    const responseBody = raw === null ? null : redactSecrets(raw);
    const entry: NetworkLogEntry = {
      category: 'network',
      method: args.method,
      url: redactSecrets(args.url),
      origin: originOf(args.url),
      status: args.status,
      opaque: args.opaque || undefined,
      durationMs: Date.now() - args.started,
      requestHeaders: extractHeaders(args.init, args.input),
      requestBody: extractBody(args.init),
      responseBody,
      error: args.error === null ? null : redactSecrets(args.error),
    };
    await enrichWithCookies(entry);
    // Stamped with the request's START, not the append. `record` is fire-and-forget and only runs after the
    // response body has been read and cookies enriched, so `Date.now()` here is when logging finished — which
    // put every entry AFTER the lifecycle frames its own response caused, and pushed a 30 s timeout a full
    // half-minute into the next cycle's frames. `ts` now means the same thing for every category: when the
    // event began. `seq` still comes from the store and remains completion order — reserving it up front
    // would mean an IndexedDB read inside the core's fetch path, which this file must never add.
    const stored = await appendLog(entry, MAX_LOG_ENTRIES, args.started);
    broadcast({ type: 'debug:log-entry', entry: stored });
  } catch {
    /* logging must never surface into the core's fetch path */
  }
}

/**
 * Whether a request should be captured: only real http(s) traffic. Relative URLs resolve against the
 * service-worker origin (chrome-extension://… / moz-extension://…), so the extension's own asset
 * fetches (icon PNGs, etc.) are excluded along with data:/blob: schemes.
 */
function isHttpUrl(rawUrl: string): boolean {
  try {
    const { protocol } = new URL(rawUrl, self.location?.href);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

/**
 * Normalize request headers (Headers | record | tuples) to a plain object, scrubbing credential values on
 * the way out. The core uses a record.
 */
function extractHeaders(init: RequestInit | undefined, input: RequestInfo | URL): Record<string, string> {
  const raw: Record<string, string> = {};
  const merge = (h: HeadersInit | undefined): void => {
    if (!h) return;
    if (h instanceof Headers) h.forEach((v, k) => (raw[k] = v));
    else if (Array.isArray(h)) for (const [k, v] of h) raw[k] = v;
    else for (const [k, v] of Object.entries(h)) raw[k] = String(v);
  };
  if (input instanceof Request) merge(input.headers);
  merge(init?.headers);
  return Object.fromEntries(Object.entries(raw).map(([name, value]) => [name, scrubHeaderValue(name, value)]));
}

/**
 * Header names whose value is a credential. Reuses {@link CREDENTIAL_KEYS} wholesale — it already carries
 * `dm-trade-token` — and adds the four names that only ever appear as a HEADER. Those are not pushed up into
 * that set on purpose: it documents itself as a mirror of the core's form/query/JSON field names, and it also
 * drives the crash reporter's stricter rules.
 */
const CREDENTIAL_HEADERS = new Set([
  ...CREDENTIAL_KEYS,
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-webapi-key',
]);

/**
 * Whether a header's value must be described rather than shown: a known credential header name, or a JWT /
 * Steam `steamid||jwt` shape under any name — an auth header we have not catalogued. The shape check keys
 * off {@link findJwt}, the same rule `redactSecrets` scrubs by, so the two cannot drift apart.
 */
function isCredentialHeader(name: string, value: string): boolean {
  return CREDENTIAL_HEADERS.has(name.toLowerCase()) || findJwt(value) !== null || decodePipes(value).includes('||');
}

/** An auth scheme in front of a token (`Bearer <jwt>`): not a secret, and it names the auth mode. */
const AUTH_SCHEME = /^([A-Za-z][A-Za-z0-9-]*) (.+)$/s;

/**
 * Describe a credential header's value; leave every other header as sent (through {@link redactSecrets} as a
 * backstop, the same two tiers cookie values get). The header NAME always survives — "which credential was
 * attached" is diagnostic, the credential itself is not.
 *
 * A `Cookie` header has no scheme to keep and is described whole; the per-cookie names, flags and expiries
 * are on `entry.cookies` already, read from chrome.cookies (see {@link enrichWithCookies}).
 */
function scrubHeaderValue(name: string, value: string): string {
  if (!isCredentialHeader(name, value)) return redactSecrets(value);
  const [, scheme, token] = AUTH_SCHEME.exec(value) ?? [];
  return scheme !== undefined && token !== undefined
    ? `${scheme} ${describeSecret(token)}`
    : describeSecret(value);
}

/**
 * Read the request body as text.
 *
 * The core's Ktor JS client does NOT hand `fetch` a string: it serializes every body (urlencoded form
 * or JSON) to bytes and passes a `Uint8Array`. Without the byte branch below, every POST the tracker
 * makes — heartbeat, trade-events, and the Steam `tradeoffer/new/send` create — logged as the useless
 * placeholder `[Uint8Array]`, which is exactly the field set you need to see when Steam answers a
 * create with an opaque `AccessDenied`. Bytes are decoded as UTF-8 and then scrubbed the same way a
 * string body is, so the redaction contract is unchanged.
 */
function extractBody(init: RequestInit | undefined): string | null {
  const body = init?.body;
  if (body == null || body === '') return null;
  if (typeof body === 'string') return redactSecrets(body);
  if (body instanceof URLSearchParams) return redactSecrets(body.toString());
  if (typeof FormData !== 'undefined' && body instanceof FormData) return redactSecrets(formDataToQuery(body));
  const text = decodeBytes(body);
  if (text != null) return redactSecrets(text);
  return describeOpaqueBody(body);
}

/** Control chars that never appear in a text body (tab/LF/CR excluded) — their presence means binary. */
// The control characters ARE the subject here: this class exists to detect them, so no-control-regex's
// usual suspicion (a stray escape in a text pattern) does not apply.
// eslint-disable-next-line no-control-regex
const BINARY_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/**
 * UTF-8 text of an `ArrayBuffer`/typed-array body, or null when it isn't text — a genuinely binary
 * payload (e.g. a future TLSN proof blob) must fall back to the shape description rather than render as
 * replacement-character noise. `fatal:true` rejects malformed UTF-8; {@link BINARY_RE} catches bytes
 * that decode cleanly but aren't text.
 */
function decodeBytes(body: BodyInit): string | null {
  let bytes: Uint8Array;
  if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
  else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  else return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return BINARY_RE.test(text) ? null : text;
  } catch {
    return null;
  }
}

/** Render a FormData body as a urlencoded query so it goes through {@link redactText} like any form. */
function formDataToQuery(body: FormData): string {
  return [...body.entries()]
    .map(([k, v]) => {
      const value = typeof v === 'string' ? encodeURIComponent(v) : `[${v.constructor?.name ?? 'File'}]`;
      return `${encodeURIComponent(k)}=${value}`;
    })
    .join('&');
}

/** Last resort for an undecodable body: name the shape AND its size, so the entry is still diagnostic. */
function describeOpaqueBody(body: BodyInit): string {
  const name = (body as object).constructor?.name ?? typeof body;
  let size: number | null = null;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) size = body.byteLength;
  else if (typeof Blob !== 'undefined' && body instanceof Blob) size = body.size;
  return size == null ? `[${name}]` : `[${name}, ${size} bytes]`;
}

async function safeText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

function originOf(url: string): NetworkLogEntry['origin'] {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return 'other';
  }
  if (DMARKET_HOST_RE.test(host)) return 'dmarket';
  if (STEAM_HOST_RE.test(host)) return 'steam';
  return 'other';
}

/**
 * Whether a cookie's value must be described rather than shown: a known credential name, or the Steam
 * `steamid||jwt` session shape under any name (a session cookie we have not catalogued). Everything else —
 * `dm_did`, `browserid`, `steamCountry`, `timezoneOffset` — is an identifier or a preference and is logged
 * as sent; a long opaque value still goes through {@link redactSecrets} as a backstop.
 */
function isCredentialCookie(name: string, value: string): boolean {
  return CREDENTIAL_KEYS.includes(name.toLowerCase()) || decodePipes(value).includes('||');
}

/** Steam writes the `steamid||jwt` separator percent-encoded in places; normalize before looking for it. */
const decodePipes = (value: string): string => value.replace(/%7C%7C/gi, '||');

/**
 * Describe a secret without disclosing it: its length, and — when it is JWT-shaped — the decoded `exp`,
 * which is the part that actually explains a session problem ("was the token already dead when this request
 * went out?"). See the module header for why a credential's raw value is never logged.
 */
function describeSecret(secret: string): string {
  const exp = jwtExpiry(secret);
  return `<redacted ${secret.length} chars${exp ? `, exp ${exp}` : ''}>`;
}

/** The `exp` of a JWT-shaped value as an ISO stamp, or null when it isn't one / carries no numeric `exp`. */
function jwtExpiry(value: string): string | null {
  const payload = (findJwt(value) ?? value).split('.')[1];
  if (payload === undefined) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: unknown };
    return typeof json.exp === 'number' ? new Date(json.exp * 1000).toISOString() : null;
  } catch {
    return null; /* not a JWT — the description falls back to the length alone */
  }
}

/**
 * Describe a cookie value. For Steam's `steamid||jwt` shape the public steamid stays readable in front of
 * the description: it is what an account-mismatch trace is read from, and it grants nothing.
 */
function describeCookieValue(value: string): string {
  const decoded = decodePipes(value);
  const sep = decoded.indexOf('||');
  if (sep < 1) return describeSecret(decoded);
  return `${decoded.slice(0, sep)}||${describeSecret(decoded.slice(sep + 2))}`;
}

/**
 * Attach the cookies actually scoped to the request URL (chrome.cookies.getAll scopes by
 * domain/path/secure). Works for HttpOnly cookies (steamLoginSecure / dm-trade-token) under the
 * existing `cookies` permission + host access. A CREDENTIAL's value is described, never disclosed — the
 * jar this reads includes the durable Steam credential; everything else is shown as sent. No-op if the
 * read fails.
 */
async function enrichWithCookies(entry: NetworkLogEntry): Promise<void> {
  try {
    const cookies = await browser.cookies.getAll({ url: entry.url });
    entry.cookies = cookies.map((c) => ({
      name: c.name,
      value: isCredentialCookie(c.name, c.value) ? describeCookieValue(c.value) : redactSecrets(c.value),
      httpOnly: c.httpOnly,
      secure: c.secure,
    }));
  } catch {
    /* no host permission / read failure */
  }
}

/** Best-effort broadcast to any open debug page (ignored when none is listening). */
function broadcast(msg: LogEntryBroadcast): void {
  try {
    void browser.runtime.sendMessage(msg).catch(() => {});
  } catch {
    /* no receiver */
  }
}
