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
//   gcs-put <file> <generation>  upload <file> as the live prod document, only if it is still <generation>,
//                                then read it back anonymously (it must stay public for the CDN)
//   schedule <version>           create the CircleCI schedule that watches for <version> (replacing one for an
//                                older version; a no-op when one for this version or newer exists). The
//                                release it belongs to comes from RELEASE_* (see scheduleFromEnv)
//   approved <workflow-id>       print `yes` when that workflow's `hold_force_update` was approved, else `no`
//   trigger <outcome> <force> <served>
//                                start the `store_release` pipeline: outcome `served|expired`, force `yes|no`
//   unschedule <schedule-id>     delete that schedule — the watch's last act
//
// THE SCHEDULE. Every release that reaches the store creates its own schedule trigger (every 30 min, branch
// `main`) through the CircleCI API v2, carrying the version, a deadline and the release pipeline's workflow id
// as pipeline parameters. It watches Chrome's update server; once the version is served it starts one
// `store_release` pipeline (the Slack notice, and the forced-update raise when approved) and deletes itself —
// so nothing runs between releases. Named `store-release-<version>`; there is at most one. The API needs a
// PERSONAL token (project tokens are not accepted by v2), and the endpoint exists only for GitHub OAuth
// projects, which this one is.
//
// THE APPROVAL LIVES IN THE RELEASE PIPELINE. `hold_force_update` is an approval job there; the watch only READS
// its state (`approved`), so no deferred pipeline ever decides whether a release is forced.
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
// THE KEY. A service-account key made by devops, in the project env var `P2P_EXTENSION_DEPLOY_SA_KEY`; the client
// that signs with it lives in gcs.mjs (no gcloud). This script never names any object but the one above; the same
// account also uploads the debug build (publish-debug-build.mjs).
//
// Environment:
//   P2P_EXTENSION_DEPLOY_SA_KEY
//                          gcs-*: base64 of the service-account JSON key (project env var, set by devops)
//   CIRCLE_API_TOKEN       schedule / approved / trigger / unschedule: a CircleCI personal API token (project
//                          env var)
//   REPO_SLUG              schedule / trigger: owner/repo (the executor sets it)
//   RELEASE_WORKFLOW_ID,
//   RELEASE_LABEL,
//   RELEASE_SHA,
//   RELEASE_ACTOR          schedule: the release it watches for (the job sets them from CIRCLE_*)
//   STORE_WATCH_VERSION,
//   STORE_WATCH_UNTIL      trigger: the watched version and deadline, forwarded with the RELEASE_* above
//
// Exit codes: 0 ok · 1 HTTP/transport/bad input · 2 usage or missing credentials · 3 the upload lost a race
// (the object's generation moved since it was read).

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compareVersions, HttpError } from './cws-upload.mjs';
import { objectUrl, storageAccessToken, uploadObject, UsageError } from './gcs.mjs';

export const EXTENSION_ID = 'leiaegebcffagcllcekifnpohnnnffpo';
export const BUCKET = 'cdn-main-dmarket-com';
export const OBJECT = 'p2p/extension-config.json';
const CACHE_CONTROL = 'public, max-age=300';
export const SCHEDULE_PREFIX = 'store-release-';
/** The approval job, in the release pipeline, whose state decides whether a release is forced. */
export const FORCE_APPROVAL_JOB = 'hold_force_update';
/** How long a release may wait for the store before its schedule gives up. Review can take a month. */
export const SCHEDULE_LIFETIME_DAYS = 45;
const CIRCLE_API = 'https://circleci.com/api/v2';
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

/**
 * Upload with `ifGenerationMatch`. Resolves the new generation, or `false` when the object moved since
 * `generation` was read.
 */
export async function gcsPut({ token, text, generation, fetch: f = fetch, bucket = BUCKET, object = OBJECT }) {
  const written = await uploadObject({
    token,
    bucket,
    object,
    bytes: Buffer.from(text),
    contentType: 'application/json',
    cacheControl: CACHE_CONTROL,
    ifGenerationMatch: generation,
    fetch: f,
  });
  if (!written) return false;
  return { generation: written.generation === undefined ? undefined : String(written.generation) };
}

/**
 * Read the object back WITHOUT credentials and require the bytes just written. The upload sends no
 * `predefinedAcl` (the account may not set ACLs), so the object takes the bucket's default object ACL — which
 * this repo cannot read. Every object in the bucket carries `allUsers: READER`, so the default is public today;
 * if that ever changes, the CDN would start answering 403 for the extension's config, silently. This turns
 * that into a failed job. Pinned to the written generation, so a later publish cannot mask it.
 */
export async function verifyPublicRead({ text, generation, fetch: f = fetch, bucket = BUCKET, object = OBJECT }) {
  const pin = generation === undefined ? '' : `&generation=${encodeURIComponent(generation)}`;
  const res = await f(`${objectUrl(bucket, object)}?alt=media${pin}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new HttpError(
      `gs://${bucket}/${object} was written but is not publicly readable (the bucket's default object ACL is ` +
        'not public?) — the CDN will not serve it; restore `allUsers: READER` on the object',
      res.status,
      await res.text(),
    );
  }
  if ((await res.text()) !== text) {
    throw new Error(`gs://${bucket}/${object} reads back different bytes than were written`);
  }
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

/** Every store-release watch of the project, with the version its name carries. */
export async function listWatchSchedules({ token, slug, fetch: f = fetch }) {
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

/**
 * The release a watch belongs to. `workflowId` is the release pipeline's workflow — the one holding
 * `hold_force_update` — and is required; the rest only feed the Slack notice.
 */
export function releaseFromEnv(env = process.env) {
  const pick = (k) => (env[k] ?? '').trim();
  const release = {
    workflowId: pick('RELEASE_WORKFLOW_ID'),
    label: pick('RELEASE_LABEL'),
    sha: pick('RELEASE_SHA'),
    actor: pick('RELEASE_ACTOR'),
  };
  if (!release.workflowId) throw new UsageError('RELEASE_WORKFLOW_ID must be set (the release job sets it)');
  return release;
}

/** The request body for the schedule that watches for `version` until `until` (an ISO date). */
export function scheduleBody(version, until, release) {
  return {
    name: `${SCHEDULE_PREFIX}${version}`,
    description: `Announce ${release.label || version} once Chrome's update server serves it, and raise web.minExtensionVersion if hold_force_update was approved (scripts/ci/force-update.sh). Deletes itself.`,
    'attribution-actor': 'current',
    parameters: {
      branch: 'main',
      store_watch_version: version,
      store_watch_until: until,
      release_workflow_id: release.workflowId,
      release_label: release.label || version,
      release_sha: release.sha,
      release_actor: release.actor,
    },
    timetable: {
      'per-hour': 2,
      'hours-of-day': Array.from({ length: 24 }, (_, h) => h),
      'days-of-week': ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
    },
  };
}

/**
 * Make sure exactly one schedule watches for the highest released version. Returns what it did: `created`,
 * `kept` (one for this version or newer already exists), and the ids of older ones it deleted. An older watch
 * is replaced because the store holds one pending submission: once a newer one was uploaded, the older
 * version will never be served, and its watch would only expire.
 */
export async function ensureSchedule({ token, slug, version, release, now = Date.now(), fetch: f = fetch }) {
  if (!isChromeVersion(version)) throw new Error(`not a numeric extension version: ${JSON.stringify(version)}`);
  const existing = await listWatchSchedules({ token, slug, fetch: f });
  if (existing.some((s) => compareVersions(s.version, version) >= 0)) return { outcome: 'kept', deleted: [] };
  const until = new Date(now + SCHEDULE_LIFETIME_DAYS * 86_400_000).toISOString().slice(0, 10);
  const created = await circle(f, token, 'POST', `/project/gh/${slug}/schedule`, scheduleBody(version, until, release));
  // Replaced only after the new one exists, so a failure in between never leaves the release unwatched.
  for (const old of existing) await circle(f, token, 'DELETE', `/schedule/${old.id}`);
  return { outcome: 'created', id: created.id, until, deleted: existing.map((s) => s.id) };
}

export async function deleteSchedule({ token, id, fetch: f = fetch }) {
  await circle(f, token, 'DELETE', `/schedule/${encodeURIComponent(id)}`);
}

/**
 * Whether the release pipeline's `hold_force_update` was approved. An approval job reads `on_hold` until
 * someone approves it and gains `approved_by` when they do; a canceled workflow, an unapproved hold or a
 * workflow without the job all read as not approved — forcing is opt-in.
 */
export async function forceApproved({ token, workflowId, job = FORCE_APPROVAL_JOB, fetch: f = fetch }) {
  let page;
  do {
    const query = page ? `?page-token=${encodeURIComponent(page)}` : '';
    const data = await circle(f, token, 'GET', `/workflow/${encodeURIComponent(workflowId)}/job${query}`);
    const hold = (data.items ?? []).find((item) => item.name === job);
    if (hold) return hold.type === 'approval' && (Boolean(hold.approved_by) || hold.status === 'success');
    page = data.next_page_token;
  } while (page);
  return false;
}

/** The parameters of the `store_release` pipeline the watch starts (declared in .circleci/config.yml). */
export function storeReleaseParameters({ outcome, force, served, env = process.env }) {
  if (outcome !== 'served' && outcome !== 'expired') throw new Error(`unknown outcome: ${JSON.stringify(outcome)}`);
  const pick = (k) => (env[k] ?? '').trim();
  return {
    store_release_outcome: outcome,
    force_update: force === true,
    store_served_version: served ?? '',
    store_watch_version: pick('STORE_WATCH_VERSION'),
    store_watch_until: pick('STORE_WATCH_UNTIL'),
    release_label: pick('RELEASE_LABEL'),
    release_sha: pick('RELEASE_SHA'),
    release_actor: pick('RELEASE_ACTOR'),
  };
}

/** Start a pipeline on `main` with `parameters`. Resolves to its number, for the log. */
export async function triggerPipeline({ token, slug, parameters, fetch: f = fetch }) {
  const data = await circle(f, token, 'POST', `/project/gh/${slug}/pipeline`, { branch: 'main', parameters });
  return data.number;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const USAGE =
  'usage: force-update.mjs served | raise <file> <version> | gcs-get <file> | gcs-put <file> <generation>' +
  ' | schedule <version> | approved <workflow-id> | trigger <served|expired> <yes|no> <served-version>' +
  ' | unschedule <schedule-id>';

function repoSlug() {
  const slug = process.env.REPO_SLUG;
  if (!slug) throw new UsageError('REPO_SLUG must be set (the CircleCI executor sets it)');
  return slug;
}

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
      const token = await storageAccessToken();
      if (cmd === 'gcs-get') {
        const { generation, text } = await gcsGet({ token });
        writeFileSync(args[0], text);
        console.log(generation);
        return EXIT.OK;
      }
      const text = readFileSync(args[0], 'utf8');
      const written = await gcsPut({ token, text, generation: args[1] });
      if (!written) {
        console.error(`gs://${BUCKET}/${OBJECT} changed since generation ${args[1]} — not overwritten.`);
        return EXIT.RACE;
      }
      await verifyPublicRead({ text, generation: written.generation });
      return EXIT.OK;
    }
    if (cmd === 'schedule' && args.length === 1) {
      const release = releaseFromEnv();
      const result = await ensureSchedule({ token: circleToken(), slug: repoSlug(), version: args[0], release });
      console.log(
        result.outcome === 'kept'
          ? `A schedule for ${args[0]} or newer already exists; nothing to do.`
          : `Created schedule ${SCHEDULE_PREFIX}${args[0]} (${result.id}), watching every 30 min until ${result.until}.` +
              (result.deleted.length ? ` Replaced: ${result.deleted.join(', ')}.` : ''),
      );
      return EXIT.OK;
    }
    if (cmd === 'approved' && args.length === 1) {
      console.log((await forceApproved({ token: circleToken(), workflowId: args[0] })) ? 'yes' : 'no');
      return EXIT.OK;
    }
    if (cmd === 'trigger' && args.length === 3 && ['yes', 'no'].includes(args[1])) {
      const parameters = storeReleaseParameters({ outcome: args[0], force: args[1] === 'yes', served: args[2] });
      const number = await triggerPipeline({ token: circleToken(), slug: repoSlug(), parameters });
      console.log(`Started pipeline ${number}: ${JSON.stringify(parameters)}`);
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
