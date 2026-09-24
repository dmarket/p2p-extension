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
// Environment (gcs-* only), project-level in CircleCI:
//   GCS_CONFIG_SA_CLIENT_EMAIL   service account allowed to read and overwrite that object
//   GCS_CONFIG_SA_PRIVATE_KEY    its private key: PEM, PEM with literal \n, or base64 of the PEM
//
// Exit codes: 0 ok · 1 HTTP/transport/bad input · 2 usage or missing credentials · 3 the upload lost a race
// (the object's generation moved since it was read).

import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compareVersions, getAccessToken, HttpError, normalizePem } from './cws-upload.mjs';

export const EXTENSION_ID = 'leiaegebcffagcllcekifnpohnnnffpo';
export const BUCKET = 'cdn-main-dmarket-com';
export const OBJECT = 'p2p/extension-config.json';
export const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';
const CACHE_CONTROL = 'public, max-age=300';
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

function readCredentials(env = process.env) {
  const email = env.GCS_CONFIG_SA_CLIENT_EMAIL;
  const raw = env.GCS_CONFIG_SA_PRIVATE_KEY;
  if (!email || !raw) {
    throw new UsageError('GCS_CONFIG_SA_CLIENT_EMAIL and GCS_CONFIG_SA_PRIVATE_KEY must be set (project env vars)');
  }
  let pem;
  try {
    pem = normalizePem(raw);
  } catch (e) {
    throw new UsageError(`GCS_CONFIG_SA_PRIVATE_KEY is unusable (${e instanceof Error ? e.message : e})`);
  }
  return { email, pem };
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

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────

const USAGE = 'usage: force-update.mjs served | raise <file> <version> | gcs-get <file> | gcs-put <file> <generation>';

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
      const token = await getAccessToken({ ...readCredentials(), scope: STORAGE_SCOPE });
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
    console.error(USAGE);
    return EXIT.USAGE;
  } catch (e) {
    console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
    return e instanceof UsageError ? EXIT.USAGE : EXIT.HTTP;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main());
