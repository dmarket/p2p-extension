#!/usr/bin/env node
// cws-upload.mjs — Chrome Web Store API v2 client for the `upload_to_store` CI job. Dependency-free.
//
//   node scripts/ci/cws-upload.mjs status                                # read-only: credentials + item state
//   node scripts/ci/cws-upload.mjs deploy <file.crx> --version <x.y.z>   # preflight → upload → poll → publish
//     --dry-run         stop after the preflight: report what WOULD happen, upload nothing
//     --skip-publish    upload as a draft, do not submit for review
//     --cancel-pending  withdraw a PENDING_REVIEW submission first (deliberate hot-fix only)
//
// WHY NOT `wxt submit` / publish-browser-extension. It is already in node_modules and speaks API v2 with
// a service account — but its upload streams the file with NO `X-Goog-Upload-File-Name` header, and for
// an item opted into Verified CRX Uploads Google's own doc says the API update must carry
// `X-Goog-Upload-Protocol: raw` + `X-Goog-Upload-File-Name: <name>.crx`. Without them the store sees a
// zip and answers "You must update your item with a crx package." The env variable names below are the
// same ones publish-browser-extension reads, so swapping it back in later costs nothing but that header.
//
// WHY v2 ONLY. API v1.1 shuts down on 2026-10-15 (publish-browser-extension 6.1.1 warns on every v1.1
// call). v2 = `publishers/{publisherId}/items/{itemId}` resources, service-account auth.
//
// Environment (required — every missing name is reported at once, values never printed):
//   CHROME_EXTENSION_ID                   the store item id (32 letters a-p)
//   CHROME_PUBLISHER_ID                   Developer Dashboard → Publisher → Settings (also in the devconsole URL)
//   CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL   the service account added under Developer Dashboard → Account
//   CHROME_SERVICE_ACCOUNT_PRIVATE_KEY    its private key: raw PEM, base64(PEM), or PEM with literal "\n"
// Optional:
//   CWS_API_BASE / CWS_TOKEN_URL / CWS_POLL_INTERVAL_MS / CWS_POLL_TIMEOUT_MS   test + tuning overrides
//
// The three behaviour switches above are CLI FLAGS, deliberately not environment variables. An env var
// set in CircleCI's project settings is STATE: it applies to every later run until someone remembers to
// remove it, so a forgotten CWS_DRY_RUN silently stops releases from ever reaching the store. A flag
// lives in the job's command, where it is visible in the config and cannot outlive the run. An
// unrecognised flag is a hard error for the same reason — a typo must not quietly mean "off".
//
// Exit codes — each one is a distinct, documented situation the runbook can name:
//   0 done (or dry run / draft, as requested)
//   1 transport or HTTP error (status + response body printed; the token is never part of either)
//   2 usage, or an environment variable missing/unusable
//   3 the store's published version is not lower than the one being uploaded — CWS would reject it, and
//     bumping only a prerelease suffix does not help (`1.0.1-beta` is manifest `1.0.1`, same as `1.0.1`).
//   4 a submission is already PENDING_REVIEW and CWS_CANCEL_PENDING is not set
//   5 the upload did not reach SUCCEEDED (itemError[] printed)
//   6 the publish call was rejected
//
// Nothing here writes to disk. The service-account PEM is handed to node:crypto as a string.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_API_BASE = 'https://chromewebstore.googleapis.com';
export const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60_000;

export const EXIT = {
  OK: 0,
  HTTP: 1,
  USAGE: 2,
  VERSION_NOT_GREATER: 3,
  PENDING_REVIEW: 4,
  UPLOAD_FAILED: 5,
  PUBLISH_REJECTED: 6,
};

// ── Credentials ───────────────────────────────────────────────────────────────────────────────────

/**
 * Accept the private key in the three shapes a CI secret ends up in: the PEM itself, the PEM with the
 * newlines flattened to literal `\n` (a JSON `private_key` value pasted as-is), or base64 of the PEM
 * (the recommended form for a multi-line secret in CircleCI's UI). Throws — with no key material in the
 * message — when none of them fits.
 */
export function normalizePem(raw) {
  const s = (raw ?? '').trim();
  if (!s) throw new Error('empty');
  if (s.includes('-----BEGIN')) return s.replaceAll('\\n', '\n');
  const decoded = Buffer.from(s.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (decoded.includes('-----BEGIN')) return decoded.replaceAll('\\n', '\n');
  throw new Error('not a PEM, not base64 of a PEM');
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/** RS256 JWT for the OAuth 2.0 JWT-bearer grant (Google service accounts). `now` in ms. */
export function buildServiceAccountJwt(email, pem, { now = Date.now(), tokenUrl = DEFAULT_TOKEN_URL, ttlSeconds = 3600 } = {}) {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: tokenUrl, iat, exp: iat + ttlSeconds }));
  const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(pem, 'base64url');
  return `${header}.${claims}.${signature}`;
}

export async function getAccessToken({ email, pem, tokenUrl = DEFAULT_TOKEN_URL, fetch: f = fetch, now }) {
  const res = await f(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: buildServiceAccountJwt(email, pem, { now, tokenUrl }),
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`token exchange failed`, res.status, text);
  const token = JSON.parse(text).access_token;
  if (!token) throw new HttpError('token exchange returned no access_token', res.status, '(body withheld)');
  return token;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────────

export class HttpError extends Error {
  constructor(message, status, body) {
    super(`${message}: HTTP ${status}${body ? `\n${body}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

function makeClient({ apiBase, token, fetch: f }) {
  return async function api(method, path, { body, headers = {} } = {}) {
    const res = await f(`${apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'x-goog-api-version': '2', ...headers },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`${method} ${path}`, res.status, text);
    return text ? JSON.parse(text) : {};
  };
}

// ── Versions ──────────────────────────────────────────────────────────────────────────────────────

/** Chrome extension versions: 1-4 dot-separated integers; missing parts count as 0 (`1.0` == `1.0.0`). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Reduce a fetchStatus response to the few facts the deploy decides on. */
export function summarizeStatus(status) {
  const channels = status.publishedItemRevisionStatus?.distributionChannels ?? [];
  let published;
  for (const ch of channels) {
    if (ch.crxVersion && (!published || compareVersions(ch.crxVersion, published) > 0)) published = ch.crxVersion;
  }
  return {
    publishedVersion: published,
    publishedState: status.publishedItemRevisionStatus?.state,
    submittedState: status.submittedItemRevisionStatus?.state,
    submittedVersion: status.submittedItemRevisionStatus?.distributionChannels?.[0]?.crxVersion,
    lastAsyncUploadState: status.lastAsyncUploadState,
    takenDown: status.takenDown === true,
    warned: status.warned === true,
  };
}

function describeStatus(s) {
  return [
    `  published  : ${s.publishedVersion ?? '(nothing published)'}${s.publishedState ? ` [${s.publishedState}]` : ''}`,
    `  submitted  : ${s.submittedState ? `${s.submittedVersion ?? '?'} [${s.submittedState}]` : '(no pending submission)'}`,
    `  last upload: ${s.lastAsyncUploadState ?? '-'}`,
    s.takenDown ? '  !! item is TAKEN DOWN for a policy violation' : null,
    s.warned ? '  !! item has an unresolved policy warning' : null,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── The deploy ────────────────────────────────────────────────────────────────────────────────────

/**
 * Preflight → upload → poll → publish. Returns `{ exitCode, outcome, status, ... }` for every situation
 * the runbook names (see EXIT); throws HttpError on a transport/HTTP failure (→ exit 1 in the CLI).
 *
 * `deps` are injectable for tests: `fetch`, `log`, `sleep`, `now`.
 */
export async function runDeploy(opts, deps = {}) {
  const {
    crx, // Buffer
    fileName,
    version,
    extensionId,
    publisherId,
    email,
    pem,
    dryRun = false,
    cancelPending = false,
    skipPublish = false,
    apiBase = DEFAULT_API_BASE,
    tokenUrl = DEFAULT_TOKEN_URL,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = opts;
  const f = deps.fetch ?? fetch;
  const log = deps.log ?? console.log;
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());

  if (!fileName.toLowerCase().endsWith('.crx')) {
    throw new Error(`upload file name must end in .crx for a Verified-CRX-Uploads item, got "${fileName}"`);
  }

  const token = await getAccessToken({ email, pem, tokenUrl, fetch: f, now: now() });
  const api = makeClient({ apiBase, token, fetch: f });
  const item = `/v2/publishers/${publisherId}/items/${extensionId}`;

  // --- Preflight: proves the credentials and both ids, and reads what the store already holds.
  const status = summarizeStatus(await api('GET', `${item}:fetchStatus`));
  log(`cws-upload: item ${extensionId} (publisher ${publisherId})\n${describeStatus(status)}`);

  if (status.publishedVersion && compareVersions(version, status.publishedVersion) <= 0) {
    log(
      `cws-upload: REFUSING — manifest version ${version} is not greater than the published ${status.publishedVersion}.\n` +
        `  The store compares manifest.version, from which WXT has already dropped any prerelease suffix,\n` +
        `  so bumping only the suffix changes nothing here: 1.0.1-beta and 1.0.1 are both manifest 1.0.1.\n` +
        `  Every release consumes one numeric version, beta or not — 1.0.1-beta, then 1.0.2-beta, then\n` +
        `  1.0.3. Bump the NUMERIC part of "version" in package.json (and rename the release branch).`,
    );
    return { exitCode: EXIT.VERSION_NOT_GREATER, outcome: 'REFUSED_VERSION', status };
  }

  if (status.submittedState === 'PENDING_REVIEW') {
    if (!cancelPending) {
      log(
        `cws-upload: REFUSING — a submission (${status.submittedVersion ?? '?'}) is already pending review.\n` +
          `  Wait for it, or re-run with --cancel-pending to withdraw it first (deliberate hot-fix only).`,
      );
      return { exitCode: EXIT.PENDING_REVIEW, outcome: 'REFUSED_PENDING_REVIEW', status };
    }
    if (dryRun) {
      log('cws-upload: DRY RUN — would cancel the pending submission.');
    } else {
      await api('POST', `${item}:cancelSubmission`, { body: '{}', headers: { 'Content-Type': 'application/json' } });
      log('cws-upload: cancelled the pending submission.');
    }
  }

  if (dryRun) {
    log(`cws-upload: DRY RUN — would upload ${fileName} (${crx.length} bytes, manifest ${version}) and ${skipPublish ? 'leave it as a draft' : 'submit it for review'}.`);
    return { exitCode: EXIT.OK, outcome: 'DRY_RUN', status };
  }

  // --- Upload. The two X-Goog-Upload headers are what makes this a CRX upload in the store's eyes.
  log(`cws-upload: uploading ${fileName} (${crx.length} bytes)…`);
  let upload = await api('POST', `/upload${item}:upload`, {
    body: crx,
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': fileName,
    },
  });
  let uploadState = upload.uploadState;
  const deadline = now() + pollTimeoutMs;
  while (uploadState === 'UPLOAD_IN_PROGRESS' || uploadState === 'IN_PROGRESS') {
    if (now() > deadline) {
      log(`cws-upload: upload still ${uploadState} after ${pollTimeoutMs} ms — giving up.`);
      return { exitCode: EXIT.UPLOAD_FAILED, outcome: 'UPLOAD_TIMEOUT', status, uploadState };
    }
    await sleep(pollIntervalMs);
    const polled = await api('GET', `${item}:fetchStatus`);
    uploadState = polled.lastAsyncUploadState ?? uploadState;
    log(`cws-upload: upload state ${uploadState}`);
  }
  if (uploadState !== 'SUCCEEDED') {
    const errors = (upload.itemError ?? []).map((e) => `  - ${e.error_code ?? e.errorCode ?? '?'}: ${e.error_detail ?? e.errorDetail ?? ''}`);
    log(`cws-upload: upload state is ${uploadState ?? 'unknown'}\n${errors.join('\n') || '  (no itemError details)'}`);
    return { exitCode: EXIT.UPLOAD_FAILED, outcome: 'UPLOAD_FAILED', status, uploadState, itemError: upload.itemError };
  }
  if (upload.crxVersion && compareVersions(upload.crxVersion, version) !== 0) {
    // The store read a different manifest version than the one we were told to expect. The package IS
    // uploaded (as a draft) at this point — say so loudly rather than publish something mislabelled.
    log(`cws-upload: the store read manifest version ${upload.crxVersion} but this run expected ${version} — not publishing.`);
    return { exitCode: EXIT.UPLOAD_FAILED, outcome: 'VERSION_MISMATCH', status, uploadState, crxVersion: upload.crxVersion };
  }
  log(`cws-upload: upload SUCCEEDED (store read manifest version ${upload.crxVersion ?? version}).`);

  if (skipPublish) {
    log('cws-upload: CWS_SKIP_PUBLISH set — left as a draft, not submitted for review.');
    return { exitCode: EXIT.OK, outcome: 'DRAFT_UPLOADED', status, crxVersion: upload.crxVersion };
  }

  // --- Publish = submit for review. Google publishes after the review passes.
  let publish;
  try {
    publish = await api('POST', `${item}:publish`, {
      body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e) {
    if (e instanceof HttpError) {
      log(`cws-upload: publish rejected — ${e.message}`);
      return { exitCode: EXIT.PUBLISH_REJECTED, outcome: 'PUBLISH_REJECTED', status, crxVersion: upload.crxVersion };
    }
    throw e;
  }
  const warnings = publish.warningInfo?.warnings ?? [];
  for (const w of warnings) log(`cws-upload: warning ${w.reason ?? '?'}: ${w.description ?? ''}`);
  log(`cws-upload: submitted for review — state ${publish.state ?? 'unknown'}.`);
  return { exitCode: EXIT.OK, outcome: 'SUBMITTED_FOR_REVIEW', status, crxVersion: upload.crxVersion, publishState: publish.state, warnings };
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const USAGE = [
  'usage: node scripts/ci/cws-upload.mjs status',
  '       node scripts/ci/cws-upload.mjs deploy <file.crx> --version <x.y.z> [--file-name <name.crx>]',
  '              [--dry-run] [--skip-publish] [--cancel-pending]',
].join('\n');

const BOOLEAN_FLAGS = ['--dry-run', '--skip-publish', '--cancel-pending'];
const VALUE_FLAGS = ['--version', '--file-name'];

/**
 * Reject anything not in the two lists above. With an env-var switch a typo means "off" and nothing
 * says so; with a flag it can be caught, so it is — a run asked to rehearse must never upload because
 * someone wrote `--dryrun`.
 */
function rejectUnknownFlags(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    if (BOOLEAN_FLAGS.includes(a)) continue;
    if (VALUE_FLAGS.includes(a)) {
      i += 1;
      continue;
    }
    console.error(`ERROR: unknown flag ${a}.\n${USAGE}`);
    process.exit(EXIT.USAGE);
  }
}

function readEnv() {
  const names = [
    'CHROME_EXTENSION_ID',
    'CHROME_PUBLISHER_ID',
    'CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL',
    'CHROME_SERVICE_ACCOUNT_PRIVATE_KEY',
  ];
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length) {
    console.error(
      `ERROR: missing environment: ${missing.join(', ')} — set them in CircleCI Project Settings -> ` +
        'Environment Variables, or export them locally (see .circleci/config.yml for the env note).',
    );
    process.exit(EXIT.USAGE);
  }
  let pem;
  try {
    pem = normalizePem(process.env.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY);
  } catch (e) {
    console.error(`ERROR: CHROME_SERVICE_ACCOUNT_PRIVATE_KEY is ${e instanceof Error ? e.message : 'unusable'} — store the PEM, or base64 of it.`);
    process.exit(EXIT.USAGE);
  }
  return {
    extensionId: process.env.CHROME_EXTENSION_ID.trim(),
    publisherId: process.env.CHROME_PUBLISHER_ID.trim(),
    email: process.env.CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL.trim(),
    pem,
    apiBase: process.env.CWS_API_BASE || DEFAULT_API_BASE,
    tokenUrl: process.env.CWS_TOKEN_URL || DEFAULT_TOKEN_URL,
    pollIntervalMs: Number(process.env.CWS_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs: Number(process.env.CWS_POLL_TIMEOUT_MS) || DEFAULT_POLL_TIMEOUT_MS,
  };
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'status' && rest.length === 0) {
      const env = readEnv();
      const token = await getAccessToken(env);
      const api = makeClient({ apiBase: env.apiBase, token, fetch });
      const status = summarizeStatus(await api('GET', `/v2/publishers/${env.publisherId}/items/${env.extensionId}:fetchStatus`));
      console.log(`cws-upload: item ${env.extensionId} (publisher ${env.publisherId})\n${describeStatus(status)}`);
      return;
    }
    if (cmd === 'deploy' && rest[0] && !rest[0].startsWith('--')) {
      const version = argValue(rest, '--version');
      if (!version || !/^\d+(\.\d+){0,3}$/.test(version)) {
        console.error(`ERROR: --version must be the manifest version (1-4 integers), got ${JSON.stringify(version)}.\n${USAGE}`);
        process.exit(EXIT.USAGE);
      }
      rejectUnknownFlags(rest);
      const env = readEnv();
      const result = await runDeploy({
        ...env,
        crx: readFileSync(rest[0]),
        fileName: argValue(rest, '--file-name') ?? basename(rest[0]),
        version,
        dryRun: rest.includes('--dry-run'),
        cancelPending: rest.includes('--cancel-pending'),
        skipPublish: rest.includes('--skip-publish'),
      });
      console.log(`cws-upload: outcome=${result.outcome}`);
      process.exit(result.exitCode);
    }
    console.error(USAGE);
    process.exit(EXIT.USAGE);
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EXIT.HTTP);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
