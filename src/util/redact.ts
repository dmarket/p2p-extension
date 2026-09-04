// Production secret scrubber for any text that leaves this extension — a crash report, and the dev session
// log's captured bodies. **Security-critical**, and the reason it lives here rather than under src/debug/:
// that directory is reachable only through a dev-gated dynamic import and is tree-shaken from production,
// so a prod module cannot import from it. The dependency runs the other way — netLog.ts imports this —
// which changes prod tree-shaking not at all and leaves exactly one copy of these rules.
//
// This is a DENYLIST, and it is the second layer, never the first. Reports built from core-origin errors
// are allow-listed field by field in src/infra/report/describe.ts, because a Kotlin/JS exception message
// can embed an entire HTTP response body and no pattern set can bound that. What this layer is for: the
// residue — a URL with a token in its query, a JWT quoted in prose, a Steam id in a page URL — plus every
// error the extension's own code produces.
//
// TWO ENTRY POINTS, because the two consumers have different threat models:
//   - {@link redactText} — for text that LEAVES THIS MACHINE (crash reports). Credentials *and* identity:
//     steamids, UUIDs, every query value, the extension origin. A report that names a person is personal
//     data, which is a store-disclosure matter, not just a taste one.
//   - {@link redactSecrets} — for the dev console's session log, which never leaves the browser except by
//     the operator's own "export" click. Only genuine secrets go: tokens, session-transfer fields, opaque
//     credential shapes. SteamIDs, device ids, deal ids and ordinary query values stay READABLE, because
//     they are what a session/mismatch bug is actually diagnosed from — `<steamid>` in both halves of an
//     account-mismatch trace tells you nothing.
//
// Mirrors the core's `NetworkRedaction` (domain/.../net/NetworkRedaction.kt), including its shape-keyed JWT
// rule. Keep the two in step: a rule added there is usually needed here too, because the extension sees
// strings the core never touched.

/** The marker every rule substitutes, matching the core's `NetworkRedaction.REDACTED`.
 *  Exported so src/util/redact.test.ts asserts against this constant rather than a literal copy of it. */
export const REDACTED = '<redacted>';

/**
 * Field names whose value is a credential or a session-transfer secret — redacted by BOTH modes. Mirrors
 * the core's `DEFAULT_SECRET_PARAM_NAMES`, plus `refresh_token` (which that set omits).
 */
export const CREDENTIAL_KEYS: readonly string[] = [
  'access_token',
  'token',
  'trade_offer_access_token',
  'tradetoken',
  'sessionid',
  'steamloginsecure',
  'steamrefresh_steam',
  'dm-trade-token',
  'nonce',
  'auth',
  'prior',
  'refresh_token',
  // The DMarket token-refresh exchange, which the core now performs directly (it used to re-mint the session
  // by loading a dmarket.com page instead). The dev network log captures both the request body,
  // `{"RefreshToken": …}` — a ~30-day bearer for the whole account — and the response, which carries a fresh
  // pair under `AuthToken`/`RefreshToken`. The access half is JWT-shaped and would also be caught by
  // {@link JWT_SHAPE}; the refresh half is opaque, so only its key name can save it. `refresh_token` above
  // does not match these: the rules compare whole names, and the wire spells them PascalCase with no
  // separator.
  'refreshtoken',
  'authtoken',
  'dm-trade-refresh-token',
];

/**
 * Field names whose value identifies the user or the install but is NOT a credential — knowing it grants
 * nothing. Redacted only in {@link redactText} (reports leave the machine); left readable in the dev
 * console, where the whole point is to see which account/device a request went out as.
 */
const IDENTITY_KEYS: readonly string[] = ['dm-trade-userid', 'dm_did'];

/**
 * A JWT-shaped run: `eyJ` (base64url of `{"`) plus two more base64url segments. Keyed on **shape**, so it
 * catches a token no key name precedes — `Bearer <jwt>`, Steam's escaped-JSON `strError`, a single-quoted
 * pseudo-JSON dump. Name-keyed matching alone provably misses all three.
 */
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

/** Non-global twin of {@link JWT_SHAPE}: `.exec` on a `g` regex carries `lastIndex` between calls. */
const JWT_SHAPE_ONCE = new RegExp(JWT_SHAPE.source);

/**
 * The first JWT-shaped run in `text`, or null. Exposes {@link JWT_SHAPE} as a lookup, for the callers that
 * DESCRIBE a secret rather than replace it — the dev log's header and cookie descriptions, which report a
 * token's length and decoded `exp`. They key off exactly this rule instead of carrying a copy of the shape.
 */
export function findJwt(text: string): string | null {
  return JWT_SHAPE_ONCE.exec(text)?.[0] ?? null;
}

// The query/fragment character classes deliberately ALLOW `<` and `>`: the core redacts its own URLs
// before we ever see them, so a query can already read `access_token=<redacted>`, and a class that
// excluded those would fail to match exactly the URLs that matter most. They stop at whitespace, quotes
// and `)` — the delimiters an exception message actually uses around a URL.

/** A URL together with its query string and/or fragment (rule 1 — see {@link redactText}). */
const URL_WITH_QUERY = /(https?:\/\/[^\s"'<>)]*?)\?([^\s"')#]*)(?:#[^\s"')]*)?/gi;

/** A URL with only a fragment. Dropped whole: `#access_token=…` is a real shape and never diagnostic. */
const URL_WITH_FRAGMENT_ONLY = /(https?:\/\/[^\s"'<>)?]*?)#[^\s"')]*/gi;

/** A 17-digit run — a steamid64. Public-ish, but it identifies a person, so it does not travel. */
const STEAM_ID = /\d{17}/g;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A long opaque run — an unrecognised credential shape. Long enough not to eat ordinary identifiers. */
const LONG_OPAQUE = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/**
 * A field name that holds an IDENTIFIER — matched by shape: anything ending in `id`/`ids`. That is the
 * whole wire vocabulary of both sides (`dealId`, `directiveId`, `steamOfferId`, `assetIds`, `deviceId`,
 * `tradeofferid`, `last_assetid`, …), so it needs no list to maintain and no per-endpoint knowledge.
 *
 * Used ONLY by {@link redactSecrets} (the dev log), and ONLY to hold such a value out of the coarse
 * length rule: DMarket deal ids are `<45-char opaque>:<uuid>`, whose first half {@link LONG_OPAQUE}
 * ate — so every trade-events response and every lifecycle frame read `"dealId": "<redacted 45 chars>:…"`
 * and could not be correlated with anything. An id is not a credential; knowing one grants nothing.
 *
 * Safe against a credential that happens to sit under an `…id` name for two reasons: the named
 * {@link CREDENTIAL_KEYS} rules and the JWT shape rule both run BEFORE this exemption is applied, so
 * anything they match is already gone by then.
 */
const IDENTIFIER_NAME = /ids?$/i;

/** The name part of {@link IDENTIFIER_NAME}, for matching an assignment inside a larger text. */
const IDENTIFIER_KEY = String.raw`[\w.-]*[Ii][Dd][Ss]?`;

/**
 * An identifier assignment together with its value, in the shapes {@link assignmentRules} covers plus
 * a JSON array (`"assetIds":["…","…"]`). Held out of the coarse length rule — see {@link IDENTIFIER_NAME}.
 */
const IDENTIFIER_SPAN = new RegExp(
  [
    // form / query: dealId=value
    String.raw`${IDENTIFIER_KEY}=[^&\s"']+`,
    // JSON, including the escaped form: "dealId":"value" / \"dealId\":\"value\"
    String.raw`\\?"${IDENTIFIER_KEY}\\?"\s*:\s*\\?"[^"\\]*`,
    // JSON array of ids: "assetIds":["a","b"]
    String.raw`\\?"${IDENTIFIER_KEY}\\?"\s*:\s*\[[^\]]*`,
    // single-quoted pseudo-JSON: 'dealId': 'value'
    String.raw`'${IDENTIFIER_KEY}'\s*:\s*'[^']*`,
    // percent-encoded JSON: %22dealId%22%3A%22value%22
    String.raw`%22${IDENTIFIER_KEY}%22%3A%22[^%]*`,
  ].join('|'),
  'g',
);

/** This build's extension origin → a stable `ext://` (the id is per-profile on an unpacked install). */
const EXTENSION_ORIGIN = /(?:chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+\//gi;

interface Rule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * One (regex, replacer) pair per secret name per shape. Built once at module load. Each shape has its own
 * capture layout, so they are applied in sequence rather than combined.
 */
function assignmentRules(keys: readonly string[]): readonly Rule[] {
  return keys.flatMap((key) => {
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      // form / query: key=value  (value runs to & or whitespace or a quote)
      { pattern: new RegExp(`(${k})=([^&\\s"']+)`, 'gi'), replacement: `$1=${REDACTED}` },
      // JSON, including the ESCAPED form Steam's `strError` carries: "key":"value" / \"key\":\"value\"
      {
        pattern: new RegExp(`(\\\\?"${k}\\\\?"\\s*:\\s*\\\\?")[^"\\\\]*(\\\\?")`, 'gi'),
        replacement: `$1${REDACTED}$2`,
      },
      // single-quoted pseudo-JSON: 'key': 'value'
      { pattern: new RegExp(`('${k}'\\s*:\\s*')[^']*(')`, 'gi'), replacement: `$1${REDACTED}$2` },
      // percent-encoded JSON: %22key%22%3A%22value%22
      { pattern: new RegExp(`(%22${k}%22%3A%22)[^%]*(%22)`, 'gi'), replacement: `$1${REDACTED}$2` },
      // Quoted literal with an UNQUOTED key, in either separator: key = "value" / key: 'value'.
      //
      // The shape a captured HTML/JS page uses, and the one the other four all missed: the `key=value` rule
      // requires no spaces and excludes the opening quote from its value class, and the JSON rules require
      // the key itself to be quoted. So Steam's own `g_sessionID = "…";` survived every rule and shipped a
      // live session id verbatim into exported session logs — under a name that IS in CREDENTIAL_KEYS and
      // was correctly redacted everywhere else. Last in the list so the more specific shapes match first.
      {
        pattern: new RegExp(`(${k}\\s*[=:]\\s*["'])[^"']*(["'])`, 'gi'),
        replacement: `$1${REDACTED}$2`,
      },
    ];
  });
}

const CREDENTIAL_RULES = assignmentRules(CREDENTIAL_KEYS);
const IDENTITY_RULES = assignmentRules(IDENTITY_KEYS);

function applyRules(text: string, rules: readonly Rule[]): string {
  let out = text;
  for (const { pattern, replacement } of rules) out = out.replace(pattern, replacement);
  return out;
}

/** Replace this build's extension origin with a stable `ext://`, so stacks group across installs.
 *  Exported for the esbuild+node harnesses only (see {@link REDACTED}); no in-repo importer. */
export function stripExtensionId(text: string): string {
  return text.replace(EXTENSION_ORIGIN, 'ext://');
}

/**
 * Redact every query-parameter **value** while keeping every **name**. Names are the diagnosis ("which
 * endpoint, called how"); values are the risk, including parameters no named rule knows about. A fragment
 * is dropped entirely.
 *
 * Keeping names is why this does not simply delete the query: the core already redacts its own URLs
 * carefully (`HttpStatusException.redactedUrl`), and blanking the whole thing here would throw that away.
 */
function redactUrlValues(text: string): string {
  return text
    .replace(URL_WITH_QUERY, (_m, base: string, query: string) => {
      const names = query
        .split('&')
        .filter((pair) => pair.length > 0)
        .map((pair) => {
          const eq = pair.indexOf('=');
          return eq < 0 ? pair : `${pair.slice(0, eq)}=${REDACTED}`;
        });
      return names.length > 0 ? `${base}?${names.join('&')}` : base;
    })
    .replace(URL_WITH_FRAGMENT_ONLY, '$1');
}

/**
 * Scrub every known secret shape out of `text`. The order is deliberate and asserted by tests:
 *
 * 1. **URLs first** — the highest-value rule. Ktor puts full request URLs into exception messages and the
 *    core appends `?access_token=…`. Every query VALUE goes, including parameters no rule below knows
 *    about, and a `#access_token=…` fragment that even the core's own `redactUrl` leaves alone.
 * 2. Named assignments (bodies and prose), so `key=<redacted>` stays readable.
 * 3. The JWT shape, for a token with no key in front of it.
 * 4. The coarse identity/length rules last, so they only see what survived.
 *
 * Callers must scrub **before** truncating: a cap landing mid-token leaves a fragment that matches nothing.
 */
export function redactText(text: string): string {
  const out = applyRules(applyRules(redactUrlValues(stripExtensionId(text)), CREDENTIAL_RULES), IDENTITY_RULES);
  return out
    .replace(JWT_SHAPE, REDACTED)
    .replace(STEAM_ID, '<steamid>')
    .replace(UUID, '<uuid>')
    .replace(LONG_OPAQUE, (m) => `<redacted ${m.length} chars>`);
}

/**
 * Scrub **credentials only**, for text that stays on this machine — the dev console's session log.
 *
 * What this deliberately KEEPS, and why: steamids, device ids, deal/asset ids, and every query value whose
 * name is not a known credential. They are the primary evidence in a session or wrong-account trace, they
 * grant nothing on their own, and the full scrubber's `<steamid>` markers made exactly the traces this tool
 * exists for unreadable.
 *
 * What still goes: the named credential fields ({@link CREDENTIAL_KEYS}) in every shape the full scrubber
 * knows, anything JWT-shaped whatever key precedes it, and any long opaque run — an unrecognised credential
 * shape. That last, coarse rule is held out of two kinds of span, because in both it was destroying the
 * evidence rather than a secret: a URL (a long path is not a secret, and `<redacted 49 chars>` hid which
 * endpoint was called) and an `…id` field's value (see {@link IDENTIFIER_NAME}).
 *
 * `fieldName` is for a caller that scrubs a value it has already split from its key — the lifecycle-frame
 * fields, where the key is not in `text` for the span rule to see. Pass it and an identifier field's value
 * is exempt from the coarse rule exactly as an inline `"dealId":"…"` is.
 *
 * Residual, accepted: a long-but-not-JWT secret sitting in a query under a name no rule knows survives here.
 * The core redacts its own URLs before we see them and the named set covers the rest; the alternative is the
 * blanket redaction that made this log useless.
 */
export function redactSecrets(text: string, fieldName?: string): string {
  const out = applyRules(text, CREDENTIAL_RULES).replace(JWT_SHAPE, REDACTED);
  if (fieldName !== undefined && IDENTIFIER_NAME.test(fieldName)) return out;
  return mapOutsideKeptSpans(out, (span) => span.replace(LONG_OPAQUE, (m) => `<redacted ${m.length} chars>`));
}

/** Any http(s) URL — one of the span kinds held out of the coarse length rule (see {@link redactSecrets}). */
const URL_SPAN = /https?:\/\/[^\s"'<>)]+/gi;

/** URLs and identifier assignments: everything the coarse length rule must not see. */
const KEPT_SPANS = new RegExp(`${URL_SPAN.source}|${IDENTIFIER_SPAN.source}`, 'gi');

/** Apply `fn` to the parts of `text` outside a {@link KEPT_SPANS} match, leaving those spans verbatim. */
function mapOutsideKeptSpans(text: string, fn: (segment: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(KEPT_SPANS)) {
    out += fn(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(text.slice(last));
}

/**
 * Scrub then truncate, in that order, reserving room for `suffix` so the part that makes the report
 * auditable (an occurrence count, a dropped count) is not what the cap eats.
 */
export function redactAndCap(text: string, maxLen: number, suffix = ''): string {
  const scrubbed = redactText(text);
  const budget = Math.max(0, maxLen - suffix.length);
  return (scrubbed.length > budget ? scrubbed.slice(0, budget) : scrubbed) + suffix;
}
