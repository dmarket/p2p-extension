#!/usr/bin/env node
// force-update.mjs — the node half of the forced-update pipeline (scripts/ci/force-update.sh drives it).
//
// Dependency-free on purpose, like cws-upload.mjs and pack-crx.mjs: the polling job runs every 30 minutes and
// should cost a checkout and one GET, not an `npm ci`.
//
// Subcommands:
//   served                       print the version Chrome's update server serves for this extension
//   raise <file> <version>       set web.minExtensionVersion in a config document to <version>, never lower;
//                                prints `raised` or `unchanged`
//   gcs-get <file>               download the live prod document to <file>, print its generation
//   gcs-put <file> <generation>  upload <file> as the live prod document, only if it is still <generation>
//   schedule <version>           create the CircleCI schedule that polls for <version> (replacing one for an
//                                older version; a no-op when one for this version or newer exists)
//   unschedule <schedule-id>     delete that schedule — the poll's last act
//
// THE SCHEDULE. A forced release creates its own schedule trigger (every 30 min, branch `main`) through the
// CircleCI API v2, carrying the version and a deadline as pipeline parameters, and the poll deletes it once
// it has published — so nothing runs between forced releases. Named `force-update-<version>`; there is at
// most one. The API needs a PERSONAL token (project tokens are not accepted by v2), and the endpoint exists
// only for GitHub OAuth projects, which this one is.
//
// THE UPDATE SERVER. `GET https://clients2.google.com/service/update2/crx?response=updatecheck&…&x=id%3D<id>
// %26v%3D0.0.0%26uc` is the request Chrome itself makes (Omaha update2), so its answer is what users actually
// get — not what the dashboard says is approved. `v=0.0.0` makes it answer with the version it serves:
// `status="ok" version="1.0.6"`. Undocumented, stable for years, no guarantees. It answers `manifest.version`,
// i.e. the numeric part only, which is also the form `web.minExtensionVersion` takes.
//
// CLOUD STORAGE. Only the one object the bucket scripts own, `p2p/extension-config.json` in the prod bucket —
// the bucket is shared with the frontend. The upload carries `ifGenerationMatch`, so a publish that landed
// after the download is never overwritten; and the same `Cache-Control` / `Content-Type` as buckets/upload.sh.
//
// NO STORED KEY. The job's CircleCI OIDC token is exchanged at Google STS for a short-lived access token
// (Workload Identity Federation, direct resource access — no service account, no key). The pool's provider
// trusts `https://oidc.circleci.com/org/<org-id>` with this project's id as the attribute condition, and the
// bucket grants that federated principal read + overwrite on THIS ONE OBJECT through an IAM condition on
// `resource.name`. IAM conditions need uniform bucket-level access on the bucket.
//
// Environment:
//   CIRCLE_OIDC_TOKEN_V2   gcs-*: set by CircleCI in the job
//   GCP_WIF_AUDIENCE       gcs-*: the pool provider, `//iam.googleapis.com/projects/<number>/locations/global/
//                          workloadIdentityPools/<pool>/providers/<provider>` (not a secret; project env var)
//   CIRCLE_API_TOKEN       schedule / unschedule: a CircleCI personal API token (project env var)
//   REPO_SLUG              schedule: owner/repo (the executor sets it)
//
// Exit codes: 0 ok · 1 HTTP/transport/bad input · 2 usage or missing credentials · 3 the upload lost a race
// (the object's generation moved since it was read).

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compareVersions, HttpError } from './cws-upload.mjs';

export const EXTENSION_ID = 'leiaegebcffagcllcekifnpohnnnffpo';
export const BUCKET = 'cdn-main-dmarket-com';
export const OBJECT = 'p2p/extension-config.json';
export const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const CACHE_CONTROL = 'public, max-age=300';
export const SCHEDULE_PREFIX = 'force-update-';
/** How long a forced release may wait for the store before its schedule gives up. Review can take a month. */
export const SCHEDULE_LIFETIME_DAYS = 45;
const CIRCLE_API = 'https://circleci.com/api/v2';
export const STS_URL = 'https://sts.googleapis.com/v1/token';
const EXIT = { OK: 0, HTTP: 1, USAGE: 2, RACE: 3 };

/** A numeric Chrome version, the only form this pipeline handles (`1.0.6`, never `1.0.6-beta`). */
export function isChromeVersion(v) {
  return typeof v === 'string' && /^\d{1,5}(\.\d{1,5}){0,3}$/.test(v) && v.split('.').every((p) => Number(p) <= 65535);
}

export function updateCheckUrl(id = EXTENSION_ID) {
  const x = encodeURIComponent(`id=${id}&v=0.0.0&uc`);
  return `https://clients2.google.com/service/update2/crx?response=updatecheck&acceptformat=crx3&prodversion=140.0&x=${x}`;
}

/** The version in an update2 answer, or `null` for `noupdate` / an unrecognised answer. */
export function parseServedVersion(xml) {
  const check = /<updatecheck\b[^>]*>/.exec(xml)?.[0];
  if (!check || !/\bstatus="ok"/.test(check)) return null;
  const version = /\bversion="([^"]+)"/.exec(check)?.[1];
  return isChromeVersion(version) ? version : null;
}

export async function servedVersion({ fetch: f = fetch } = {}) {
  const res = await f(updateCheckUrl());
  const text = await res.text();
  if (!res.ok) throw new HttpError('update server', res.status, text.slice(0, 300));
  return parseServedVersion(text);
}

/**
 * Raise `web.minExtensionVersion` in a config document to `version`. Never lowers it: the pipeline only moves
 * the minimum up, and a document that is already at or past the target is left byte-for-byte alone.
 */
export function raiseMinimum(text, version) {
  if (!isChromeVersion(version)) throw new Error(`not a numeric extension version: ${JSON.stringify(version)}`);
  const doc = JSON.parse(text);
  if (typeof doc !== 'object' || doc === null || typeof doc.web !== 'object' || doc.web === null) {
    throw new Error('not a config document: no `web` group');
  }
  const current = doc.web.minExtensionVersion;
  if (isChromeVersion(current) && compareVersions(current, version) >= 0) return { text, raised: false, current };
  doc.web.minExtensionVersion = version;
  return { text: `${JSON.stringify(doc, null, 2)}\n`, raised: true, current };
}

// ── Cloud Storage ─────────────────────────────────────────────────────────────────────────────────

class UsageError extends Error {}

/** Exchange the job's CircleCI OIDC token for a Cloud Storage access token (Workload Identity Federation). */
export async function federatedAccessToken({ env = process.env, fetch: f = fetch } = {}) {
  const subjectToken = (env.CIRCLE_OIDC_TOKEN_V2 ?? '').trim();
  const audience = (env.GCP_WIF_AUDIENCE ?? '').trim();
  if (!subjectToken) throw new UsageError('CIRCLE_OIDC_TOKEN_V2 is not set — CircleCI sets it in every job');
  if (!audience) throw new UsageError('GCP_WIF_AUDIENCE must be set (project env var, the pool provider name)');
  const res = await f(STS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grantType: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience,
      scope: STORAGE_SCOPE,
      requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      subjectToken,
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
    }),
  });
  const text = await res.text();
  // The body names the failed attribute condition or audience; it never echoes the subject token.
  if (!res.ok) throw new HttpError('STS token exchange', res.status, text);
  const token = JSON.parse(text).access_token;
  if (!token) throw new HttpError('STS token exchange returned no access_token', res.status, '(body withheld)');
  return token;
}

const objectUrl = (bucket, object) =>
  `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`;

/** Download the live object at one generation: metadata first, then the bytes pinned to that generation. */
export async function gcsGet({ token, fetch: f = fetch, bucket = BUCKET, object = OBJECT }) {
  const auth = { Authorization: `Bearer ${token}` };
  const meta = await f(`${objectUrl(bucket, object)}?fields=generation`, { headers: auth });
  if (!meta.ok) throw new HttpError(`reading gs://${bucket}/${object}`, meta.status, await meta.text());
  const { generation } = await meta.json();
  const media = await f(`${objectUrl(bucket, object)}?alt=media&generation=${generation}`, { headers: auth });
  if (!media.ok) throw new HttpError(`downloading gs://${bucket}/${object}`, media.status, await media.text());
  return { generation: String(generation), text: await media.text() };
}

/** Upload with `ifGenerationMatch`. Resolves `false` when the object moved since `generation` was read. */
export async function gcsPut({ token, text, generation, fetch: f = fetch, bucket = BUCKET, object = OBJECT }) {
  const boundary = `force-update-${Date.now().toString(36)}`;
  const metadata = { name: object, contentType: 'application/json', cacheControl: CACHE_CONTROL };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o` +
    `?uploadType=multipart&ifGenerationMatch=${encodeURIComponent(generation)}`;
  const res = await f(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (res.status === 412) return false;
  if (!res.ok) throw new HttpError(`uploading gs://${bucket}/${object}`, res.status, await res.text());
  return true;
}

// ── CircleCI schedule ─────────────────────────────────────────────────────────────────────────────

function circleToken(env = process.env) {
  const token = (env.CIRCLE_API_TOKEN ?? '').trim();
  if (!token) throw new UsageError('CIRCLE_API_TOKEN must be set (project env var, a CircleCI personal API token)');
  return token;
}

async function circle(f, token, method, path, body) {
  const res = await f(`${CIRCLE_API}${path}`, {
    method,
    headers: { 'Circle-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(`CircleCI ${method} ${path}`, res.status, text);
  return text ? JSON.parse(text) : {};
}

/** Every force-update schedule of the project, with the version its name carries. */
export async function listForceSchedules({ token, slug, fetch: f = fetch }) {
  const out = [];
  let page;
  do {
    const query = page ? `?page-token=${encodeURIComponent(page)}` : '';
    const data = await circle(f, token, 'GET', `/project/gh/${slug}/schedule${query}`);
    for (const item of data.items ?? []) {
      const version = typeof item.name === 'string' ? item.name.slice(SCHEDULE_PREFIX.length) : '';
      if (item.name?.startsWith(SCHEDULE_PREFIX) && isChromeVersion(version)) out.push({ id: item.id, version });
    }
    page = data.next_page_token;
  } while (page);
  return out;
}

/** The request body for the schedule that polls for `version` until `until` (an ISO date). */
export function scheduleBody(version, until) {
  return {
    name: `${SCHEDULE_PREFIX}${version}`,
    description: `Raise web.minExtensionVersion to ${version} once Chrome's update server serves it (scripts/ci/force-update.sh). Deletes itself.`,
    'attribution-actor': 'current',
    parameters: { branch: 'main', force_update_version: version, force_update_until: until },
    timetable: {
      'per-hour': 2,
      'hours-of-day': Array.from({ length: 24 }, (_, h) => h),
      'days-of-week': ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    },
  };
}

/**
 * Make sure exactly one schedule polls for the highest forced version. Returns what it did: `created`,
 * `kept` (one for this version or newer already exists), and the ids of older ones it deleted.
 */
export async function ensureSchedule({ token, slug, version, now = Date.now(), fetch: f = fetch }) {
  if (!isChromeVersion(version)) throw new Error(`not a numeric extension version: ${JSON.stringify(version)}`);
  const existing = await listForceSchedules({ token, slug, fetch: f });
  if (existing.some((s) => compareVersions(s.version, version) >= 0)) return { outcome: 'kept', deleted: [] };
  const until = new Date(now + SCHEDULE_LIFETIME_DAYS * 86_400_000).toISOString().slice(0, 10);
  const created = await circle(f, token, 'POST', `/project/gh/${slug}/schedule`, scheduleBody(version, until));
  // Replaced only after the new one exists, so a failure in between never leaves the release unwatched.
  for (const old of existing) await circle(f, token, 'DELETE', `/schedule/${old.id}`);
  return { outcome: 'created', id: created.id, until, deleted: existing.map((s) => s.id) };
}

export async function deleteSchedule({ token, id, fetch: f = fetch }) {
  await circle(f, token, 'DELETE', `/schedule/${encodeURIComponent(id)}`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: force-update.mjs served | raise <file> <version> | gcs-get <file> | gcs-put <file> <generation>' +
  ' | schedule <version> | unschedule <schedule-id>';

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    if (cmd === 'served' && args.length === 0) {
      const version = await servedVersion();
      if (!version) throw new Error('the update server serves no version of this extension');
      console.log(version);
      return EXIT.OK;
    }
    if (cmd === 'raise' && args.length === 2) {
      const [file, version] = args;
      const result = raiseMinimum(readFileSync(file, 'utf8'), version);
      if (result.raised) writeFileSync(file, result.text);
      console.log(result.raised ? 'raised' : 'unchanged');
      return EXIT.OK;
    }
    if ((cmd === 'gcs-get' && args.length === 1) || (cmd === 'gcs-put' && args.length === 2)) {
      const token = await federatedAccessToken();
      if (cmd === 'gcs-get') {
        const { generation, text } = await gcsGet({ token });
        writeFileSync(args[0], text);
        console.log(generation);
        return EXIT.OK;
      }
      const ok = await gcsPut({ token, text: readFileSync(args[0], 'utf8'), generation: args[1] });
      if (!ok) {
        console.error(`gs://${BUCKET}/${OBJECT} changed since generation ${args[1]} — not overwritten.`);
        return EXIT.RACE;
      }
      return EXIT.OK;
    }
    if (cmd === 'schedule' && args.length === 1) {
      const slug = process.env.REPO_SLUG;
      if (!slug) throw new UsageError('REPO_SLUG must be set (the CircleCI executor sets it)');
      const result = await ensureSchedule({ token: circleToken(), slug, version: args[0] });
      console.log(
        result.outcome === 'kept'
          ? `A schedule for ${args[0]} or newer already exists; nothing to do.`
          : `Created schedule ${SCHEDULE_PREFIX}${args[0]} (${result.id}), polling every 30 min until ${result.until}.` +
              (result.deleted.length ? ` Replaced: ${result.deleted.join(', ')}.` : ''),
      );
      return EXIT.OK;
    }
    if (cmd === 'unschedule' && args.length === 1) {
      await deleteSchedule({ token: circleToken(), id: args[0] });
      console.log(`Deleted schedule ${args[0]}.`);
      return EXIT.OK;
    }
    console.error(USAGE);
    return EXIT.USAGE;
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof UsageError ? EXIT.USAGE : EXIT.HTTP;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
