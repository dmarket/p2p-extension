// Dependency-free formatting for the log viewer: curl reconstruction, body decoding, and JSON/curl
// syntax highlighting (returns escaped HTML for dangerouslySetInnerHTML — MV3 CSP forbids a remote
// highlight lib). Ported from the tracker-core debug dashboard (tools/debug-extension/dashboard.js).

import type { NetworkLogEntry } from '@/debug/protocol';

/** Escape the three HTML-significant chars before building highlighted markup. */
const escapeHtml = (s: string): string =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Wrap JSON tokens (keys, strings, numbers, booleans, null) in coloured spans. Input is escaped first. */
export function highlightJson(json: string): string {
  return escapeHtml(json).replace(
    /("(?:\\.|[^"\\])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m) => {
      let cls = 'tok-num';
      if (m[0] === '"') cls = /:\s*$/.test(m) ? 'tok-key' : 'tok-str';
      else if (m === 'null') cls = 'tok-null';
      else if (m === 'true' || m === 'false') cls = 'tok-bool';
      return `<span class="${cls}">${m}</span>`;
    },
  );
}

/** Colour a curl command: the `curl` keyword, flags (-X/-H/-b/--data), and single-quoted arguments. */
function highlightCurl(text: string): string {
  return escapeHtml(text)
    .replace(/^curl\b/, '<span class="tok-cmd">curl</span>')
    .replace(
      /(^|\s)(-X|-H|-b|--data(?:-raw)?)(?=\s)/g,
      (_m, sp: string, flag: string) => `${sp}<span class="tok-flag">${flag}</span>`,
    )
    .replace(/'(?:\\.|[^'\\])*'/g, (m) => `<span class="tok-str">${m}</span>`);
}

/** Return highlighted HTML for a body, or the escaped plain text when it isn't a highlightable shape. */
export function highlight(text: string, lang: 'json' | 'curl'): string {
  if (lang === 'curl') return highlightCurl(text);
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) return highlightJson(text);
  return escapeHtml(text);
}

/** Single-quote a value for a POSIX shell (wraps in '…', escaping embedded single quotes). */
const shq = (s: string): string => `'${String(s).replace(/'/g, "'\\''")}'`;

/**
 * Reconstruct the request as a copy-pasteable curl command: method, URL, the captured request headers
 * (`Authorization` included, as its description), the cookies actually sent (via `-b`, attached SW-side
 * from chrome.cookies), and the body verbatim.
 *
 * `--data` carries the body exactly as sent (urlencoded on one line) so the command stays replayable;
 * the decoded, per-field view lives in the viewer's separate `request` block. Credential header values,
 * credential cookie values and the secret form fields are descriptions rather than values (see netLog.ts),
 * so a copied command needs those substituted by hand before it will actually run; identifiers are as sent.
 */
export function buildCurl(e: NetworkLogEntry): string {
  const parts = [`curl -X ${e.method} ${shq(e.url)}`];
  for (const [k, v] of Object.entries(e.requestHeaders || {})) {
    parts.push(`-H ${shq(`${k}: ${v}`)}`);
  }
  if (e.cookies && e.cookies.length) {
    parts.push(`-b ${shq(e.cookies.map((c) => `${c.name}=${c.value}`).join('; '))}`);
  }
  if (e.requestBody != null && e.requestBody !== '') {
    parts.push(`--data ${shq(e.requestBody)}`);
  }
  return parts.join(' \\\n  ');
}

/** Pretty-print a JSON body, decode an x-www-form-urlencoded body, else return as-is. Null if empty. */
export function decodeBody(raw: string | null): string | null {
  if (raw == null || raw === '') return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    /* not JSON */
  }
  if (raw.includes('=') && !raw.includes('\n')) {
    try {
      const pairs = [...new URLSearchParams(raw).entries()];
      if (pairs.length) return pairs.map(([k, v]) => `${k} = ${expandJsonValue(v)}`).join('\n');
    } catch {
      /* not form-encoded */
    }
  }
  return raw;
}

/**
 * Pretty-print a form value that is itself a JSON document. Steam's `tradeoffer/new/send` packs the
 * interesting half of the request into two such fields — `json_tradeoffer` (the assets) and
 * `trade_offer_create_params` (the trade-offer access token) — so a flat `key = {"newversion":true,…}`
 * line hides precisely what a rejected create needs checked. Continuation lines are indented so the
 * block still reads as one field.
 */
function expandJsonValue(value: string): string {
  const t = value.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
      .split('\n')
      .map((line, i) => (i === 0 ? line : `  ${line}`))
      .join('\n');
  } catch {
    return value;
  }
}

const truncate = (s: string): string => (s && s.length > 80 ? `${s.slice(0, 80)}…` : s || '');

/** One-line summary for the collapsed entry head. */
export function summarize(e: NetworkLogEntry): string {
  return `${e.method} ${e.origin} ${e.status ?? (e.error ? 'ERR' : '')} — ${truncate(e.url)}`;
}
