// gcs.mjs — the Cloud Storage client for the CI scripts (publish-debug-build.mjs).
//
// Dependency-free on purpose, like the rest of scripts/ci: the jobs that use it run no `npm ci`.
//
// THE KEY. A service-account key made by devops, in the project env var `P2P_EXTENSION_DEPLOY_SA_KEY` (base64 of the
// JSON key file, the same shape the frontend's `gcloud_auth` step decodes). No gcloud: the key's `client_email` +
// `private_key` sign a JWT-bearer grant for a short-lived Cloud Storage token (cws-upload.mjs `getAccessToken`), and
// everything else is the JSON API. Devops scope the account to the objects these scripts own: the debug build
// under the stage CI-artifacts prefix (publish-debug-build.mjs).

import { randomBytes } from 'node:crypto';
import { getAccessToken, HttpError, normalizePem } from './cws-upload.mjs';

export const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_write';

/** A missing or malformed input — the caller maps it to exit code 2. */
export class UsageError extends Error {}

/**
 * The service account behind `P2P_EXTENSION_DEPLOY_SA_KEY`: base64 of the JSON key file, or the JSON itself.
 * Errors name the variable and the missing field, never any key material.
 */
export function readServiceAccountKey(env = process.env) {
  const raw = (env.P2P_EXTENSION_DEPLOY_SA_KEY ?? '').trim();
  if (!raw) throw new UsageError('P2P_EXTENSION_DEPLOY_SA_KEY must be set (project env var, base64 of the JSON key)');
  let key;
  try {
    key = JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8'));
  } catch {
    throw new UsageError('P2P_EXTENSION_DEPLOY_SA_KEY is neither a JSON key nor base64 of one');
  }
  if (typeof key?.client_email !== 'string' || !key.client_email) {
    throw new UsageError('P2P_EXTENSION_DEPLOY_SA_KEY has no client_email');
  }
  let pem;
  try {
    pem = normalizePem(key.private_key);
  } catch {
    throw new UsageError('P2P_EXTENSION_DEPLOY_SA_KEY has no usable private_key');
  }
  return { email: key.client_email, pem, ...(typeof key.token_uri === 'string' ? { tokenUrl: key.token_uri } : {}) };
}

/** A short-lived Cloud Storage token for that account (JWT-bearer grant). */
export async function storageAccessToken({ env = process.env, fetch: f = fetch } = {}) {
  return getAccessToken({ ...readServiceAccountKey(env), scope: STORAGE_SCOPE, fetch: f });
}

export const objectUrl = (bucket, object) =>
  `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`;

/**
 * Upload `bytes` as `gs://<bucket>/<object>` in one multipart request, so the metadata lands with the bytes.
 * Binary-safe (the body is a Buffer). Without `ifGenerationMatch` an existing object is REPLACED — which needs
 * `storage.objects.delete` on it as well as `create`. With it, the write happens only if the object is still at
 * that generation (`0` = only if absent), and a lost precondition resolves `false` rather than throwing.
 *
 * Resolves the object resource GCS returns (`generation`, `size`, `md5Hash`, …).
 */
export async function uploadObject({
  token,
  bucket,
  object,
  bytes,
  contentType,
  cacheControl,
  metadata,
  ifGenerationMatch,
  fetch: f = fetch,
}) {
  const boundary = `gcs-${randomBytes(16).toString('hex')}`;
  const resource = { name: object, contentType, cacheControl, ...(metadata ? { metadata } : {}) };
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(resource)}\r\n` +
        `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const precondition =
    ifGenerationMatch === undefined ? '' : `&ifGenerationMatch=${encodeURIComponent(ifGenerationMatch)}`;
  const res = await f(
    `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=multipart${precondition}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  if (res.status === 412) return false;
  if (!res.ok) throw new HttpError(`uploading gs://${bucket}/${object}`, res.status, await res.text());
  return res.json().catch(() => ({}));
}
