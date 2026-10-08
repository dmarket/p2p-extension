#!/usr/bin/env node
// publish-debug-build.mjs — upload the debug build to Cloud Storage as the QA autotests' `latest.zip`.
//
// Run by the `publish_debug_build` job (.circleci/config.yml) after a green `build-debug` on `main`. The UI
// autotests install the debug build (debug console, internal dev/stage endpoints) into Chrome before they run, and
// download it from this object with their own credentials — not from CircleCI artifacts, which would need a
// CircleCI token.
//
// OVERWRITE, ALWAYS. One multipart upload with no precondition: an existing object is replaced, and whichever build
// finishes last is `latest`. That is deliberate — no ordering guard. Replacing an object needs
// `storage.objects.delete` on it as well as `storage.objects.create`; an account with objectCreator alone can make
// the first copy and then fails on every later push, so a 403 says exactly that.
//
// THE TARGET is a project env var, not a constant: this repository is public and stage bucket names stay out of it
// (the same reason buckets/ reads REMOTE_CONFIG_STAGE_BUCKET from .env).
//
// The object carries custom metadata — `version`, `commit`, `buildUrl` — so `gsutil stat` tells QA which build
// they installed. `Cache-Control: no-store`, in case the object is ever served through a cache.
//
// Environment:
//   DEBUG_BUILD_GCS_URI          gs://<bucket>/<object> (project env var)
//   P2P_EXTENSION_DEPLOY_SA_KEY  base64 of the service-account JSON key (project env var, set by devops; gcs.mjs)
//   CIRCLE_SHA1, CIRCLE_BUILD_URL
//                                the build, for the object's metadata (CircleCI sets them)
//
// Input: artifacts/dmarket-p2p-extension-<package.json version>-chrome-dev.zip, which `build-debug` persists to
// the workspace (scripts/ci/collect-artifacts.sh). Named explicitly, like there: a missing zip is an error, never
// a glob that uploads something else.
//
// Exit codes: 0 uploaded · 1 HTTP/transport/integrity · 2 usage or missing input.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HttpError } from './cws-upload.mjs';
import { storageAccessToken, uploadObject, UsageError } from './gcs.mjs';

export const TARGET_ENV = 'DEBUG_BUILD_GCS_URI';
const CONTENT_TYPE = 'application/zip';
const CACHE_CONTROL = 'no-store';
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXIT = { OK: 0, HTTP: 1, USAGE: 2 };

/** `gs://<bucket>/<object>` from the environment. Bucket names follow GCS's naming rules; the object is a file. */
export function parseTarget(env = process.env) {
  const raw = (env[TARGET_ENV] ?? '').trim();
  if (!raw) throw new UsageError(`${TARGET_ENV} must be set (project env var, gs://<bucket>/<object>)`);
  const match = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,220}[a-z0-9])\/([^/].*)$/.exec(raw);
  if (!match || match[2].endsWith('/')) {
    throw new UsageError(`${TARGET_ENV} is not gs://<bucket>/<object>: ${JSON.stringify(raw)}`);
  }
  return { bucket: match[1], object: match[2] };
}

/** The zip `build-debug` leaves in the workspace, by the same template as collect-artifacts.sh. */
export function debugZipPath(version) {
  return `artifacts/dmarket-p2p-extension-${version}-chrome-dev.zip`;
}

/** Custom metadata identifying the build; empty values are left out. */
export function buildMetadata(env, version) {
  const fields = { version, commit: env.CIRCLE_SHA1, buildUrl: env.CIRCLE_BUILD_URL };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.trim()));
}

/**
 * Upload `bytes` over whatever is at the target, then check that GCS stored exactly those bytes. Resolves the new
 * generation and the md5, and whether GCS returned an md5 to compare against.
 */
export async function publishDebugBuild({ token, bytes, target, metadata, fetch: f = fetch }) {
  let written;
  try {
    written = await uploadObject({
      token,
      ...target,
      bytes,
      contentType: CONTENT_TYPE,
      cacheControl: CACHE_CONTROL,
      metadata,
      fetch: f,
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 403) {
      throw new HttpError(
        `uploading gs://${target.bucket}/${target.object} was refused. Replacing an existing object needs ` +
          'storage.objects.delete as well as storage.objects.create on it: with objectCreator alone the first ' +
          'upload succeeds and every later one fails here. Ask devops for roles/storage.objectUser on the prefix',
        e.status,
        e.body,
      );
    }
    throw e;
  }
  // No precondition was sent, so there is none to lose; a `false` here would mean GCS answered 412 anyway.
  if (!written) throw new Error(`gs://${target.bucket}/${target.object}: unexpected 412 on an unconditional upload`);

  const md5 = createHash('md5').update(bytes).digest('base64');
  if (written.size !== undefined && Number(written.size) !== bytes.length) {
    throw new Error(`GCS stored ${written.size} bytes, the zip has ${bytes.length}`);
  }
  if (written.md5Hash !== undefined && written.md5Hash !== md5) {
    throw new Error(`GCS stored md5 ${written.md5Hash}, the zip's is ${md5}`);
  }
  return {
    generation: written.generation === undefined ? undefined : String(written.generation),
    md5,
    md5Verified: written.md5Hash !== undefined,
  };
}

/** The whole job. Inputs are checked before any network call, so a misconfigured run costs nothing. */
export async function run({
  env = process.env,
  fetch: f = fetch,
  root = ROOT,
  readFile = readFileSync,
  log = console.log,
  warn = console.error,
} = {}) {
  try {
    const target = parseTarget(env);
    const { version } = JSON.parse(readFile(join(root, 'package.json'), 'utf8'));
    const file = debugZipPath(version);
    let bytes;
    try {
      bytes = readFile(join(root, file));
    } catch {
      throw new UsageError(`${file} not found — build-debug persists it to the workspace (collect-artifacts.sh)`);
    }
    const token = await storageAccessToken({ env, fetch: f });
    const result = await publishDebugBuild({ token, bytes, target, metadata: buildMetadata(env, version), fetch: f });
    if (!result.md5Verified) warn('WARN: GCS returned no md5Hash; only the size was checked.');
    log(
      `Uploaded ${file} (${bytes.length} B, md5 ${result.md5}) to gs://${target.bucket}/${target.object}, ` +
        `generation ${result.generation ?? '?'}` +
        (env.CIRCLE_SHA1 ? `, commit ${env.CIRCLE_SHA1.slice(0, 7)}` : '') +
        '.',
    );
    return EXIT.OK;
  } catch (e) {
    warn(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof UsageError ? EXIT.USAGE : EXIT.HTTP;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 2) {
    console.error('usage: node scripts/ci/publish-debug-build.mjs   (configured through the environment)');
    process.exit(EXIT.USAGE);
  }
  process.exit(await run());
}
