import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  ensureSchedule,
  forceApproved,
  gcsGet,
  gcsPut,
  listWatchSchedules,
  parseServedVersion,
  raiseMinimum,
  readServiceAccountKey,
  releaseFromEnv,
  scheduleBody,
  servedVersion,
  storageAccessToken,
  storeReleaseParameters,
  triggerPipeline,
  updateCheckUrl,
  verifyPublicRead,
} from './force-update.mjs';

// The forced-update pipeline raises the minimum only when Chrome's update server serves the build, only
// upwards, and never over a publish that landed after it read the document.

const OK = `<?xml version="1.0"?><gupdate><app appid="x" status="ok"><updatecheck codebase="https://x/a.crx" hash_sha256="ab" size="1" status="ok" version="1.0.6"/></app></gupdate>`;
const NOUPDATE = `<gupdate><app appid="x" status="ok"><updatecheck _esbAllowlist="false" status="noupdate"/></app></gupdate>`;
const DOC = `${JSON.stringify({ tracker: {}, web: { remoteConfigFetchIntervalMs: 3600000, minExtensionVersion: '1.0.6' } }, null, 2)}\n`;

describe("Chrome's update server", () => {
  it('asks as a client at 0.0.0, so the answer is the version it serves', () => {
    const url = new URL(updateCheckUrl('abc'));
    expect(url.host).toBe('clients2.google.com');
    expect(url.searchParams.get('response')).toBe('updatecheck');
    expect(url.searchParams.get('x')).toBe('id=abc&v=0.0.0&uc');
  });

  it('reads the served version, and nothing from `noupdate` or an unknown answer', () => {
    expect(parseServedVersion(OK)).toBe('1.0.6');
    expect(parseServedVersion(NOUPDATE)).toBeNull();
    expect(parseServedVersion('<html>error</html>')).toBeNull();
    expect(parseServedVersion(OK.replace('1.0.6', '1.0.6-beta'))).toBeNull();
  });

  it('fails loudly on a non-2xx instead of reading it as "not served yet"', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('boom', { status: 503 })));
    await expect(servedVersion({ fetch: f })).rejects.toThrow(/HTTP 503/);
  });
});

describe('raising the minimum', () => {
  it('raises it, keeping the document pretty-printed as buckets/ keeps it', () => {
    const { text, raised } = raiseMinimum(DOC, '1.0.7');
    expect(raised).toBe(true);
    expect(JSON.parse(text).web.minExtensionVersion).toBe('1.0.7');
    expect(text).toBe(DOC.replace('"1.0.6"', '"1.0.7"'));
  });

  it('never lowers it and leaves the bytes alone when already there', () => {
    expect(raiseMinimum(DOC, '1.0.6')).toEqual({ text: DOC, raised: false, current: '1.0.6' });
    expect(raiseMinimum(DOC, '1.0.5').raised).toBe(false);
    expect(raiseMinimum(DOC, '1.0.10').raised).toBe(true);
  });

  it('refuses a label suffix and a document without a `web` group', () => {
    expect(() => raiseMinimum(DOC, '1.0.7-beta')).toThrow(/numeric/);
    expect(() => raiseMinimum('{"tracker":{}}', '1.0.7')).toThrow(/web/);
  });
});

describe('Cloud Storage', () => {
  it('downloads the bytes of the exact generation it read', async () => {
    const f = vi.fn((url) =>
      Promise.resolve(
        url.includes('fields=generation')
          ? new Response(JSON.stringify({ generation: '42' }))
          : new Response(url.includes('alt=media&generation=42') ? DOC : 'wrong generation'),
      ),
    );
    await expect(gcsGet({ token: 't', fetch: f })).resolves.toEqual({ generation: '42', text: DOC });
    expect(f.mock.calls[0][0]).toContain('/b/cdn-main-dmarket-com/o/p2p%2Fextension-config.json');
  });

  it('uploads only over the generation it read, with the bucket scripts’ headers', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ generation: 43 }))));
    await expect(gcsPut({ token: 't', text: DOC, generation: '42', fetch: f })).resolves.toEqual({
      generation: '43',
    });
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('uploadType=multipart&ifGenerationMatch=42');
    expect(init.body).toContain('"cacheControl":"public, max-age=300"');
    expect(init.body).toContain('"name":"p2p/extension-config.json"');
    expect(init.body).toContain(DOC);
  });

  it('reports a lost race as `false`, not as success or an error', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('precondition', { status: 412 })));
    await expect(gcsPut({ token: 't', text: DOC, generation: '42', fetch: f })).resolves.toBe(false);
  });

  it('reads the written generation back without credentials', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(DOC)));
    await verifyPublicRead({ text: DOC, generation: '43', fetch: f });
    const [url, init] = f.mock.calls[0];
    expect(url).toContain('/o/p2p%2Fextension-config.json?alt=media&generation=43');
    expect(init.headers).toBeUndefined();
  });

  it('fails when the written object is not public — the CDN would answer 403', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('Anonymous caller', { status: 403 })));
    await expect(verifyPublicRead({ text: DOC, generation: '43', fetch: f })).rejects.toThrow(/not publicly readable/);
  });

  it('fails when the public copy is not what was written', async () => {
    const f = vi.fn(() => Promise.resolve(new Response('{}')));
    await expect(verifyPublicRead({ text: DOC, generation: '43', fetch: f })).rejects.toThrow(/different bytes/);
  });
});

describe('the deploy service-account key', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const json = {
    type: 'service_account',
    client_email: 'p2p-ext@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://token.test/token',
  };
  const env = { P2P_EXTENSION_DEPLOY_SA_KEY: Buffer.from(JSON.stringify(json)).toString('base64') };

  it('reads the base64 JSON key, as devops stores it, and the raw JSON too', () => {
    expect(readServiceAccountKey(env)).toMatchObject({ email: json.client_email, tokenUrl: json.token_uri });
    expect(readServiceAccountKey({ P2P_EXTENSION_DEPLOY_SA_KEY: JSON.stringify(json) }).email).toBe(json.client_email);
  });

  it('signs a JWT-bearer grant for the Cloud Storage scope at the token_uri from the key', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ access_token: 'ya29.x' }))));
    await expect(storageAccessToken({ env, fetch: f })).resolves.toBe('ya29.x');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(json.token_uri);
    const assertion = new URLSearchParams(init.body).get('assertion');
    const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({
      iss: json.client_email,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: json.token_uri,
    });
  });

  it('names what is wrong, without key material, and calls nothing', async () => {
    const f = vi.fn();
    await expect(storageAccessToken({ env: {}, fetch: f })).rejects.toThrow(/P2P_EXTENSION_DEPLOY_SA_KEY must be set/);
    expect(() => readServiceAccountKey({ P2P_EXTENSION_DEPLOY_SA_KEY: 'not-a-key' })).toThrow(/neither a JSON key/);
    const noPem = Buffer.from(JSON.stringify({ ...json, private_key: '' })).toString('base64');
    expect(() => readServiceAccountKey({ P2P_EXTENSION_DEPLOY_SA_KEY: noPem })).toThrow(/no usable private_key/);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('the per-release schedule', () => {
  /** A fake CircleCI API over an in-memory schedule list; `calls` records method + path in order. */
  function fakeCircle(items) {
    const calls = [];
    const f = vi.fn((url, init = {}) => {
      const path = url.replace('https://circleci.com/api/v2', '');
      const method = init.method ?? 'GET';
      calls.push(`${method} ${path}`);
      if (method === 'GET') return Promise.resolve(new Response(JSON.stringify({ items, next_page_token: null })));
      if (method === 'POST') return Promise.resolve(new Response(JSON.stringify({ id: 'new-id' }), { status: 201 }));
      return Promise.resolve(new Response('{}'));
    });
    return { f, calls };
  }

  const RELEASE = { workflowId: 'wf-1', label: '1.0.7-beta', sha: 'abc123', actor: 'someone' };

  it('watches every 30 min on main, carrying the version, a deadline and the release pipeline it came from', () => {
    const body = scheduleBody('1.0.7', '2026-11-08', RELEASE);
    expect(body.name).toBe('store-release-1.0.7');
    expect(body.parameters).toEqual({
      branch: 'main',
      store_watch_version: '1.0.7',
      store_watch_until: '2026-11-08',
      release_workflow_id: 'wf-1',
      release_label: '1.0.7-beta',
      release_sha: 'abc123',
      release_actor: 'someone',
    });
    expect(body.timetable['per-hour']).toBe(2);
    expect(body.timetable['hours-of-day']).toHaveLength(24);
    expect(body.timetable['days-of-week']).toHaveLength(7);
  });

  it('creates one, with a 45-day deadline, when none is waiting', async () => {
    const { f, calls } = fakeCircle([{ id: 'other', name: 'nightly' }]);
    const now = Date.UTC(2026, 8, 24);
    await expect(ensureSchedule({ token: 't', slug: 'dmarket/p2p-extension', version: '1.0.7', release: RELEASE, now, fetch: f })).resolves.toEqual({
      outcome: 'created',
      id: 'new-id',
      until: '2026-11-08',
      deleted: [],
    });
    expect(calls).toEqual(['GET /project/gh/dmarket/p2p-extension/schedule', 'POST /project/gh/dmarket/p2p-extension/schedule']);
  });

  it('ignores the old force-update- schedules, which this pipeline no longer creates', async () => {
    const { f, calls } = fakeCircle([{ id: 'legacy', name: 'force-update-1.0.8' }]);
    await expect(ensureSchedule({ token: 't', slug: 's/r', version: '1.0.7', release: RELEASE, fetch: f })).resolves.toMatchObject({ outcome: 'created', deleted: [] });
    expect(calls).toEqual(['GET /project/gh/s/r/schedule', 'POST /project/gh/s/r/schedule']);
  });

  it('replaces a wait for an older version — creating first, so the release is never unwatched', async () => {
    const { f, calls } = fakeCircle([{ id: 'old', name: 'store-release-1.0.6' }]);
    const result = await ensureSchedule({ token: 't', slug: 's/r', version: '1.0.7', release: RELEASE, fetch: f });
    expect(result.deleted).toEqual(['old']);
    expect(calls).toEqual(['GET /project/gh/s/r/schedule', 'POST /project/gh/s/r/schedule', 'DELETE /schedule/old']);
  });

  it('keeps a wait for this version or a newer one and creates nothing', async () => {
    const { f, calls } = fakeCircle([{ id: 'newer', name: 'store-release-1.0.8' }]);
    await expect(ensureSchedule({ token: 't', slug: 's/r', version: '1.0.7', release: RELEASE, fetch: f })).resolves.toEqual({ outcome: 'kept', deleted: [] });
    expect(calls).toEqual(['GET /project/gh/s/r/schedule']);
  });

  it('follows the list across pages and ignores schedules it does not own', async () => {
    const pages = [
      { items: [{ id: 'a', name: 'store-release-1.0.6' }, { id: 'b', name: 'store-release-junk' }], next_page_token: 'p2' },
      { items: [{ id: 'c', name: 'something-else' }], next_page_token: null },
    ];
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify(pages.shift()))));
    await expect(listWatchSchedules({ token: 't', slug: 's/r', fetch: f })).resolves.toEqual([{ id: 'a', version: '1.0.6' }]);
    expect(f.mock.calls[1][0]).toContain('page-token=p2');
  });
});

describe('the release the watch belongs to', () => {
  it('needs the release workflow id — it is where the forced-update approval lives', () => {
    expect(() => releaseFromEnv({})).toThrow(/RELEASE_WORKFLOW_ID/);
    expect(releaseFromEnv({ RELEASE_WORKFLOW_ID: ' wf ', RELEASE_LABEL: '1.0.7-beta' })).toEqual({
      workflowId: 'wf',
      label: '1.0.7-beta',
      sha: '',
      actor: '',
    });
  });
});

describe('reading the forced-update approval', () => {
  const jobs = (items, next = null) => Promise.resolve(new Response(JSON.stringify({ items, next_page_token: next })));
  const hold = (extra) => ({ name: 'hold_force_update', type: 'approval', ...extra });

  it('is approved once someone approved the hold', async () => {
    const f = vi.fn(() => jobs([{ name: 'release', type: 'build', status: 'success' }, hold({ status: 'success', approved_by: 'u-1' })]));
    await expect(forceApproved({ token: 't', workflowId: 'wf-1', fetch: f })).resolves.toBe(true);
    expect(f.mock.calls[0][0]).toBe('https://circleci.com/api/v2/workflow/wf-1/job');
  });

  it('is not approved while on hold, when canceled, or when the workflow has no such job', async () => {
    for (const items of [[hold({ status: 'on_hold' })], [hold({ status: 'canceled' })], [{ name: 'release', type: 'build' }]]) {
      await expect(forceApproved({ token: 't', workflowId: 'wf', fetch: vi.fn(() => jobs(items)) })).resolves.toBe(false);
    }
  });

  it('never reads a same-named build job as an approval', async () => {
    const f = vi.fn(() => jobs([{ name: 'hold_force_update', type: 'build', status: 'success' }]));
    await expect(forceApproved({ token: 't', workflowId: 'wf', fetch: f })).resolves.toBe(false);
  });

  it('follows the job list across pages', async () => {
    const pages = [jobs([{ name: 'a', type: 'build' }], 'p2'), jobs([hold({ approved_by: 'u' })])];
    const f = vi.fn(() => pages.shift());
    await expect(forceApproved({ token: 't', workflowId: 'wf', fetch: f })).resolves.toBe(true);
    expect(f.mock.calls[1][0]).toContain('page-token=p2');
  });
});

describe('starting the store_release pipeline', () => {
  const ENV = { STORE_WATCH_VERSION: '1.0.7', STORE_WATCH_UNTIL: '2026-11-08', RELEASE_LABEL: '1.0.7-beta', RELEASE_SHA: 'abc', RELEASE_ACTOR: 'me' };

  it('carries the outcome, the force decision as a boolean and the release for the notice', () => {
    expect(storeReleaseParameters({ outcome: 'served', force: true, served: '1.0.7', env: ENV })).toEqual({
      store_release_outcome: 'served',
      force_update: true,
      store_served_version: '1.0.7',
      store_watch_version: '1.0.7',
      store_watch_until: '2026-11-08',
      release_label: '1.0.7-beta',
      release_sha: 'abc',
      release_actor: 'me',
    });
    expect(storeReleaseParameters({ outcome: 'expired', force: false, served: '1.0.6', env: ENV }).force_update).toBe(false);
    expect(() => storeReleaseParameters({ outcome: 'maybe', env: ENV })).toThrow(/outcome/);
  });

  it('starts it on main', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ number: 42 }), { status: 201 })));
    await expect(triggerPipeline({ token: 't', slug: 's/r', parameters: { a: 1 }, fetch: f })).resolves.toBe(42);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://circleci.com/api/v2/project/gh/s/r/pipeline');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ branch: 'main', parameters: { a: 1 } });
  });
});
