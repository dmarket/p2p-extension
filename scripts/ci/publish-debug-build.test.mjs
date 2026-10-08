import { describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { buildMetadata, debugZipPath, parseTarget, publishDebugBuild, run } from './publish-debug-build.mjs';

// The debug build goes to Cloud Storage as `latest.zip` after every green build-debug on main. The upload must
// REPLACE whatever is there, carry the bytes intact, and say plainly when the account may create but not replace.

const TARGET = { bucket: 'ci-artifacts', object: 'p2p-extension/debug/latest.zip' };
const URI = `gs://${TARGET.bucket}/${TARGET.object}`;
const md5 = (bytes) => createHash('md5').update(bytes).digest('base64');

/** Split a multipart/related body back into its JSON resource and its media part, byte-exact. */
function parseMultipart(init) {
  const boundary = /boundary=(\S+)/.exec(init.headers['Content-Type'])[1];
  const body = init.body;
  const sep = Buffer.from(`--${boundary}\r\n`);
  const first = body.indexOf(sep) + sep.length;
  const second = body.indexOf(sep, first);
  const header = '\r\n\r\n';
  const json = body.subarray(body.indexOf(header, first) + header.length, second - 2).toString();
  const mediaStart = body.indexOf(header, second + sep.length) + header.length;
  const mediaEnd = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
  return { resource: JSON.parse(json), media: body.subarray(mediaStart, mediaEnd) };
}

const stored = (bytes, generation = '1700000000000001') =>
  new Response(JSON.stringify({ generation, size: String(bytes.length), md5Hash: md5(bytes) }));

describe('the target', () => {
  it('reads gs://<bucket>/<object> from the environment', () => {
    expect(parseTarget({ DEBUG_BUILD_GCS_URI: ` ${URI} ` })).toEqual(TARGET);
  });

  it('names the variable when it is missing or not a gs:// object path', () => {
    expect(() => parseTarget({})).toThrow(/DEBUG_BUILD_GCS_URI must be set/);
    for (const bad of ['https://x/y.zip', 'gs://ci-artifacts', 'gs://ci-artifacts/', 'gs://ci-artifacts/dir/', 'gs://X/y']) {
      expect(() => parseTarget({ DEBUG_BUILD_GCS_URI: bad }), bad).toThrow(/is not gs:\/\/<bucket>\/<object>/);
    }
  });

  it('expects the zip collect-artifacts.sh leaves, and metadata without empty fields', () => {
    expect(debugZipPath('1.0.6-beta')).toBe('artifacts/dmarket-p2p-extension-1.0.6-beta-chrome-dev.zip');
    expect(buildMetadata({ CIRCLE_SHA1: 'abc', CIRCLE_BUILD_URL: '' }, '1.0.6')).toEqual({ version: '1.0.6', commit: 'abc' });
  });
});

describe('the upload', () => {
  // Random bytes plus the sequences a careless multipart builder would trip on.
  const zip = Buffer.concat([Buffer.from('PK\u0003\u0004'), randomBytes(4096), Buffer.from('\r\n--x\r\n\r\n'), randomBytes(64)]);
  const metadata = { version: '1.0.6', commit: 'abc1234', buildUrl: 'https://ci/1' };

  it('overwrites: no precondition, so an existing object is replaced rather than refused', async () => {
    const f = vi.fn(() => Promise.resolve(stored(zip)));
    await expect(publishDebugBuild({ token: 't', bytes: zip, target: TARGET, metadata, fetch: f })).resolves.toEqual({
      generation: '1700000000000001',
      md5: md5(zip),
      md5Verified: true,
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://storage.googleapis.com/upload/storage/v1/b/ci-artifacts/o?uploadType=multipart');
    expect(url).not.toContain('ifGenerationMatch');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer t');
  });

  it('sends the zip byte-for-byte, with its metadata in the same request', async () => {
    const f = vi.fn(() => Promise.resolve(stored(zip)));
    await publishDebugBuild({ token: 't', bytes: zip, target: TARGET, metadata, fetch: f });
    const { resource, media } = parseMultipart(f.mock.calls[0][1]);
    expect(Buffer.compare(media, zip)).toBe(0);
    expect(resource).toEqual({
      name: TARGET.object,
      contentType: 'application/zip',
      cacheControl: 'no-store',
      metadata,
    });
  });

  it('turns a 403 into the permission it most likely lacks', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('does not have storage.objects.delete access', { status: 403 })));
    await expect(publishDebugBuild({ token: 't', bytes: zip, target: TARGET, metadata, fetch: f })).rejects.toThrow(
      /storage\.objects\.delete as well as storage\.objects\.create[\s\S]*HTTP 403[\s\S]*does not have/,
    );
  });

  it('fails when GCS stored different bytes', async () => {
    const f = vi.fn(() => Promise.resolve(stored(Buffer.from('something else'))));
    await expect(publishDebugBuild({ token: 't', bytes: zip, target: TARGET, metadata, fetch: f })).rejects.toThrow(
      /GCS stored/,
    );
  });

  it('accepts a reply without md5Hash, but reports that only the size was checked', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ generation: 7, size: String(zip.length) }))));
    await expect(publishDebugBuild({ token: 't', bytes: zip, target: TARGET, metadata, fetch: f })).resolves.toMatchObject({
      generation: '7',
      md5Verified: false,
    });
  });
});

describe('the job', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    client_email: 'p2p-ext@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://token.test/token',
  };
  const env = {
    DEBUG_BUILD_GCS_URI: URI,
    P2P_EXTENSION_DEPLOY_SA_KEY: Buffer.from(JSON.stringify(key)).toString('base64'),
    CIRCLE_SHA1: 'abc1234def',
    CIRCLE_BUILD_URL: 'https://ci/1',
  };
  const zip = randomBytes(256);
  const files = {
    [join('/repo', 'package.json')]: JSON.stringify({ version: '1.0.6-beta' }),
    [join('/repo', debugZipPath('1.0.6-beta'))]: zip,
  };
  const readFile = (path) => {
    if (!(path in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return files[path];
  };
  const quiet = { log: vi.fn(), warn: vi.fn() };

  it('gets a token, uploads the version-named zip, and exits 0', async () => {
    const f = vi.fn((url) =>
      Promise.resolve(url === key.token_uri ? new Response(JSON.stringify({ access_token: 'ya29.x' })) : stored(zip)),
    );
    const log = vi.fn();
    await expect(run({ env, fetch: f, root: '/repo', readFile, log, warn: vi.fn() })).resolves.toBe(0);
    expect(f.mock.calls.map(([url]) => url)).toEqual([
      key.token_uri,
      'https://storage.googleapis.com/upload/storage/v1/b/ci-artifacts/o?uploadType=multipart',
    ]);
    // A token for the Web Store's scope would be refused by Cloud Storage with a 403 that looks like a permission gap.
    const assertion = new URLSearchParams(f.mock.calls[0][1].body).get('assertion');
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_write' });
    expect(Buffer.compare(parseMultipart(f.mock.calls[1][1]).media, zip)).toBe(0);
    expect(log.mock.calls[0][0]).toMatch(/to gs:\/\/ci-artifacts\/p2p-extension\/debug\/latest\.zip, generation \d+, commit abc1234\./);
  });

  it('stops before any network call when the target, the key or the zip is missing (exit 2)', async () => {
    const f = vi.fn();
    const missing = [
      [{ ...env, DEBUG_BUILD_GCS_URI: '' }, readFile, /DEBUG_BUILD_GCS_URI must be set/],
      [{ ...env, P2P_EXTENSION_DEPLOY_SA_KEY: '' }, readFile, /P2P_EXTENSION_DEPLOY_SA_KEY must be set/],
      [env, (p) => (p.endsWith('package.json') ? files[p] : readFile('nope')), /chrome-dev\.zip not found/],
    ];
    for (const [e, rf, message] of missing) {
      const warn = vi.fn();
      await expect(run({ env: e, fetch: f, root: '/repo', readFile: rf, ...quiet, warn })).resolves.toBe(2);
      expect(warn.mock.calls[0][0]).toMatch(message);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('exits 1 on an HTTP failure', async () => {
    const f = vi.fn((url) =>
      Promise.resolve(
        url === key.token_uri
          ? new Response(JSON.stringify({ access_token: 'ya29.x' }))
          : new Response('backend error', { status: 503 }),
      ),
    );
    await expect(run({ env, fetch: f, root: '/repo', readFile, ...quiet })).resolves.toBe(1);
  });
});
