// Tests for scripts/ci/cws-upload.mjs — the Chrome Web Store API v2 client behind `upload_to_store`.
//
// Everything runs against an injected fake `fetch` that records each request, so the assertions are on
// what would go over the wire: the JWT the token exchange carries (decoded and verified with the test
// key), the two X-Goog-Upload headers that make the store treat the body as a CRX, the exact publish
// body, and — the part that matters most — which calls are NOT made in each refusal path.

import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  EXIT,
  buildServiceAccountJwt,
  compareVersions,
  getAccessToken,
  normalizePem,
  runDeploy,
  summarizeStatus,
} from './cws-upload.mjs';

let pem;
let publicKey;
beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
  publicKey = pair.publicKey;
});

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * A fake fetch keyed on the URL's tail. `routes` maps a suffix (or a function of the URL) to a Response
 * or a function returning one; the calls are recorded on `.calls`.
 */
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    for (const [suffix, handler] of Object.entries(routes)) {
      if (u.endsWith(suffix)) return typeof handler === 'function' ? handler(u, init, calls) : handler;
    }
    throw new Error(`unexpected request: ${init.method ?? 'GET'} ${u}`);
  };
  f.calls = calls;
  return f;
}

const BASE_OPTS = () => ({
  crx: Buffer.from('Cr24\x03\x00\x00\x00fake'),
  fileName: 'dmarket-p2p-extension-1.0.1-chrome.crx',
  version: '1.0.1',
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
  publisherId: 'pub-123',
  email: 'ci@project.iam.gserviceaccount.com',
  pem,
  apiBase: 'https://cws.test',
  tokenUrl: 'https://token.test/token',
  pollIntervalMs: 1,
});

const published = (v, extra = {}) => ({
  publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ deployPercentage: 100, crxVersion: v }] },
  lastAsyncUploadState: 'SUCCEEDED',
  ...extra,
});

const ROUTES_HAPPY = (statusBody, uploadBody = { uploadState: 'SUCCEEDED', crxVersion: '1.0.1' }) => ({
  '/token': json({ access_token: 'tok-1', expires_in: 3599 }),
  ':fetchStatus': json(statusBody),
  ':upload': json(uploadBody),
  ':publish': json({ state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'REASON_X', description: 'x' }] } }),
  ':cancelSubmission': json({}),
});

const quiet = { log: () => {}, sleep: async () => {}, now: () => 1_700_000_000_000 };

describe('normalizePem', () => {
  it('passes a PEM through', () => {
    expect(normalizePem(pem)).toBe(pem.trim());
  });
  it('restores literal \\n (a JSON private_key value pasted as-is)', () => {
    const flat = pem.trim().replaceAll('\n', '\\n');
    expect(normalizePem(flat)).toBe(pem.trim());
  });
  it('decodes base64 of the PEM, ignoring wrapping whitespace', () => {
    const b64 = Buffer.from(pem).toString('base64').replace(/(.{64})/g, '$1\n');
    expect(normalizePem(b64)).toBe(pem);
  });
  it('rejects garbage without echoing it', () => {
    expect(() => normalizePem('hello')).toThrow(/not a PEM/);
    expect(() => normalizePem('')).toThrow(/empty/);
  });
});

describe('buildServiceAccountJwt', () => {
  it('is an RS256 JWT with the Google JWT-bearer claims, verifiable with the key', () => {
    const jwt = buildServiceAccountJwt('sa@x.iam.gserviceaccount.com', pem, { now: 1_700_000_000_000, tokenUrl: 'https://token.test/token' });
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url'))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(c, 'base64url'))).toEqual({
      iss: 'sa@x.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/chromewebstore',
      aud: 'https://token.test/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${c}`), createPublicKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey), Buffer.from(s, 'base64url'))).toBe(false);
  });
});

describe('getAccessToken', () => {
  it('posts the assertion as a form and returns access_token', async () => {
    const f = fakeFetch({ '/token': json({ access_token: 'tok-9' }) });
    await expect(getAccessToken({ email: 'a@b', pem, tokenUrl: 'https://token.test/token', fetch: f })).resolves.toBe('tok-9');
    const [call] = f.calls;
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const params = call.body;
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion').split('.')).toHaveLength(3);
  });
  it('fails with the HTTP status and body on a refused exchange', async () => {
    const f = fakeFetch({ '/token': json({ error: 'invalid_grant' }, 400) });
    await expect(getAccessToken({ email: 'a@b', pem, tokenUrl: 'https://token.test/token', fetch: f })).rejects.toThrow(/HTTP 400[\s\S]*invalid_grant/);
  });
});

describe('compareVersions', () => {
  it.each([
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.0.0', '1.0', 0],
    ['1.0', '1.0.0', 0],
    ['1.0.0.1', '1.0.0', 1],
    ['2', '1.9.9.9', 1],
    ['1.10.0', '1.9.0', 1],
  ])('%s vs %s → %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});

describe('summarizeStatus', () => {
  it('takes the highest published channel version and the submitted state', () => {
    const s = summarizeStatus({
      publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.0.0' }, { crxVersion: '1.0.2' }] },
      submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.3' }] },
      lastAsyncUploadState: 'SUCCEEDED',
      takenDown: false,
    });
    expect(s).toMatchObject({ publishedVersion: '1.0.2', publishedState: 'PUBLISHED', submittedState: 'PENDING_REVIEW', submittedVersion: '1.0.3', takenDown: false });
  });
  it('is defined for an item that has nothing published or submitted', () => {
    expect(summarizeStatus({})).toMatchObject({ publishedVersion: undefined, submittedState: undefined });
  });
});

describe('runDeploy', () => {
  const only = (f, suffix) => f.calls.filter((c) => c.url.endsWith(suffix));

  it('happy path: preflight → upload with the CRX headers → publish DEFAULT_PUBLISH', async () => {
    const f = fakeFetch(ROUTES_HAPPY(published('1.0.0')));
    const r = await runDeploy(BASE_OPTS(), { ...quiet, fetch: f });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.outcome).toBe('SUBMITTED_FOR_REVIEW');
    expect(r.warnings).toEqual([{ reason: 'REASON_X', description: 'x' }]);

    const [upload] = only(f, ':upload');
    expect(upload.url).toBe('https://cws.test/upload/v2/publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop:upload');
    expect(upload.method).toBe('POST');
    expect(upload.headers).toMatchObject({
      Authorization: 'Bearer tok-1',
      'x-goog-api-version': '2',
      'Content-Type': 'application/octet-stream',
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': 'dmarket-p2p-extension-1.0.1-chrome.crx',
    });
    expect(Buffer.isBuffer(upload.body)).toBe(true);

    const publishes = only(f, ':publish');
    expect(publishes).toHaveLength(1);
    expect(publishes[0].url).toBe('https://cws.test/v2/publishers/pub-123/items/abcdefghijklmnopabcdefghijklmnop:publish');
    expect(JSON.parse(publishes[0].body)).toEqual({ publishType: 'DEFAULT_PUBLISH' });
    expect(only(f, ':cancelSubmission')).toHaveLength(0);
  });

  it('refuses (exit 3) when the published version is not lower — and uploads nothing', async () => {
    const f = fakeFetch(ROUTES_HAPPY(published('1.0.1')));
    const r = await runDeploy(BASE_OPTS(), { ...quiet, fetch: f });
    expect(r.exitCode).toBe(EXIT.VERSION_NOT_GREATER);
    expect(only(f, ':upload')).toHaveLength(0);
    expect(only(f, ':publish')).toHaveLength(0);
  });

  it('treats 1.0.0 published vs 1.0.0 candidate (a prerelease-suffix bump) as not greater', async () => {
    const f = fakeFetch(ROUTES_HAPPY(published('1.0.0')));
    const r = await runDeploy({ ...BASE_OPTS(), version: '1.0.0', fileName: 'x-1.0.0-beta.2.crx' }, { ...quiet, fetch: f });
    expect(r.exitCode).toBe(EXIT.VERSION_NOT_GREATER);
  });

  it('refuses (exit 4) on a pending review unless cancelPending, which cancels first', async () => {
    const pending = published('1.0.0', { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '1.0.0.5' }] } });
    const f1 = fakeFetch(ROUTES_HAPPY(pending));
    const r1 = await runDeploy(BASE_OPTS(), { ...quiet, fetch: f1 });
    expect(r1.exitCode).toBe(EXIT.PENDING_REVIEW);
    expect(only(f1, ':upload')).toHaveLength(0);
    expect(only(f1, ':cancelSubmission')).toHaveLength(0);

    const f2 = fakeFetch(ROUTES_HAPPY(pending));
    const r2 = await runDeploy({ ...BASE_OPTS(), cancelPending: true }, { ...quiet, fetch: f2 });
    expect(r2.exitCode).toBe(EXIT.OK);
    const order = f2.calls.map((c) => c.url.split(':').pop());
    expect(order.indexOf('cancelSubmission')).toBeLessThan(order.indexOf('upload'));
  });

  it('dry run stops after the preflight: token + fetchStatus only', async () => {
    const f = fakeFetch(ROUTES_HAPPY(published('1.0.0')));
    const r = await runDeploy({ ...BASE_OPTS(), dryRun: true }, { ...quiet, fetch: f });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.outcome).toBe('DRY_RUN');
    expect(f.calls.map((c) => c.url.split(/[/:]/).pop())).toEqual(['token', 'fetchStatus']);
  });

  it('dry run with a pending review and cancelPending does NOT cancel', async () => {
    const pending = published('1.0.0', { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } });
    const f = fakeFetch(ROUTES_HAPPY(pending));
    await runDeploy({ ...BASE_OPTS(), dryRun: true, cancelPending: true }, { ...quiet, fetch: f });
    expect(only(f, ':cancelSubmission')).toHaveLength(0);
  });

  it('polls fetchStatus while the upload is in progress, then publishes once', async () => {
    let polls = 0;
    const f = fakeFetch({
      ...ROUTES_HAPPY(published('1.0.0'), { uploadState: 'UPLOAD_IN_PROGRESS' }),
      ':fetchStatus': () => {
        polls += 1;
        // 1st call = preflight; 2nd = still in progress; 3rd = done.
        return json({ ...published('1.0.0'), lastAsyncUploadState: polls >= 3 ? 'SUCCEEDED' : 'UPLOAD_IN_PROGRESS' });
      },
    });
    const r = await runDeploy(BASE_OPTS(), { ...quiet, fetch: f });
    expect(r.exitCode).toBe(EXIT.OK);
    expect(polls).toBe(3);
    expect(only(f, ':publish')).toHaveLength(1);
  });

  it('gives up (exit 5) when the upload stays in progress past the deadline', async () => {
    let t = 0;
    const f = fakeFetch({
      ...ROUTES_HAPPY(published('1.0.0'), { uploadState: 'UPLOAD_IN_PROGRESS' }),
      ':fetchStatus': () => json({ ...published('1.0.0'), lastAsyncUploadState: 'UPLOAD_IN_PROGRESS' }),
    });
    const r = await runDeploy({ ...BASE_OPTS(), pollTimeoutMs: 50 }, { ...quiet, fetch: f, now: () => (t += 30) });
    expect(r.exitCode).toBe(EXIT.UPLOAD_FAILED);
    expect(r.outcome).toBe('UPLOAD_TIMEOUT');
    expect(only(f, ':publish')).toHaveLength(0);
  });

  it('exit 5 with the itemError details when the upload fails, and does not publish', async () => {
    const f = fakeFetch(ROUTES_HAPPY(published('1.0.0'), {
      uploadState: 'FAILURE',
      itemError: [{ error_code: 'PKG_INVALID_CRX', error_detail: 'You must update your item with a crx package.' }],
    }));
    const lines = [];
    const r = await runDeploy(BASE_OPTS(), { ...quiet, log: (l) => lines.push(l), fetch: f });
    expect(r.exitCode).toBe(EXIT.UPLOAD_FAILED);
    expect(lines.join('\n')).toMatch(/PKG_INVALID_CRX: You must update your item with a crx package/);
    expect(only(f, ':publish')).toHaveLength(0);
  });

  it('exit 5 and no publish when the store read a different manifest version than expected', async () => {
    const f = fakeFetch(ROUTES_HAPPY(published('1.0.0'), { uploadState: 'SUCCEEDED', crxVersion: '1.0.2' }));
    const r = await runDeploy(BASE_OPTS(), { ...quiet, fetch: f });
    expect(r.exitCode).toBe(EXIT.UPLOAD_FAILED);
    expect(r.outcome).toBe('VERSION_MISMATCH');
    expect(only(f, ':publish')).toHaveLength(0);
  });

  it('skipPublish uploads and stops (exit 0, DRAFT_UPLOADED)', async () => {
    const f = fakeFetch(ROUTES_HAPPY(published('1.0.0')));
    const r = await runDeploy({ ...BASE_OPTS(), skipPublish: true }, { ...quiet, fetch: f });
    expect(r).toMatchObject({ exitCode: EXIT.OK, outcome: 'DRAFT_UPLOADED' });
    expect(only(f, ':upload')).toHaveLength(1);
    expect(only(f, ':publish')).toHaveLength(0);
  });

  it('exit 6 when the publish call is rejected', async () => {
    const f = fakeFetch({ ...ROUTES_HAPPY(published('1.0.0')), ':publish': json({ error: { message: 'nope' } }, 400) });
    const r = await runDeploy(BASE_OPTS(), { ...quiet, fetch: f });
    expect(r).toMatchObject({ exitCode: EXIT.PUBLISH_REJECTED, outcome: 'PUBLISH_REJECTED' });
  });

  it('throws (→ exit 1) on an HTTP failure in the preflight, with status and body', async () => {
    const f = fakeFetch({ '/token': json({ access_token: 't' }), ':fetchStatus': json({ error: { status: 'PERMISSION_DENIED' } }, 403) });
    await expect(runDeploy(BASE_OPTS(), { ...quiet, fetch: f })).rejects.toThrow(/HTTP 403[\s\S]*PERMISSION_DENIED/);
  });

  it('refuses a file name that is not .crx before touching the network', async () => {
    const f = fakeFetch({});
    await expect(runDeploy({ ...BASE_OPTS(), fileName: 'ext.zip' }, { ...quiet, fetch: f })).rejects.toThrow(/must end in \.crx/);
    expect(f.calls).toHaveLength(0);
  });

  it('never puts the token anywhere but the Authorization header', async () => {
    const f = fakeFetch(ROUTES_HAPPY(published('1.0.0')));
    const lines = [];
    await runDeploy(BASE_OPTS(), { ...quiet, log: (l) => lines.push(l), fetch: f });
    expect(lines.join('\n')).not.toContain('tok-1');
    for (const c of f.calls.filter((c) => !c.url.endsWith('/token'))) expect(c.url).not.toContain('tok-1');
  });
});
