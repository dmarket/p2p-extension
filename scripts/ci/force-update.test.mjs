import { describe, expect, it, vi } from 'vitest';
import {
  ensureSchedule,
  federatedAccessToken,
  gcsGet,
  gcsPut,
  listForceSchedules,
  parseServedVersion,
  raiseMinimum,
  scheduleBody,
  servedVersion,
  STS_URL,
  updateCheckUrl,
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
    const f = vi.fn(() => Promise.resolve(new Response('{}')));
    await expect(gcsPut({ token: 't', text: DOC, generation: '42', fetch: f })).resolves.toBe(true);
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
});

describe('Workload Identity Federation', () => {
  const env = { CIRCLE_OIDC_TOKEN_V2: 'oidc.jwt', GCP_WIF_AUDIENCE: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/c' };

  it('exchanges the job OIDC token for a Cloud Storage access token, with no stored key', async () => {
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ access_token: 'ya29.x' }))));
    await expect(federatedAccessToken({ env, fetch: f })).resolves.toBe('ya29.x');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(STS_URL);
    expect(JSON.parse(init.body)).toMatchObject({
      audience: env.GCP_WIF_AUDIENCE,
      subjectToken: 'oidc.jwt',
      subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt',
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
    });
  });

  it('names the missing setting instead of calling STS', async () => {
    const f = vi.fn();
    await expect(federatedAccessToken({ env: { ...env, GCP_WIF_AUDIENCE: '' }, fetch: f })).rejects.toThrow(/GCP_WIF_AUDIENCE/);
    await expect(federatedAccessToken({ env: { ...env, CIRCLE_OIDC_TOKEN_V2: '' }, fetch: f })).rejects.toThrow(/OIDC/);
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

  it('polls every 30 min on main, carrying the version and a deadline', () => {
    const body = scheduleBody('1.0.7', '2026-11-08');
    expect(body.name).toBe('force-update-1.0.7');
    expect(body.parameters).toEqual({ branch: 'main', force_update_version: '1.0.7', force_update_until: '2026-11-08' });
    expect(body.timetable['per-hour']).toBe(2);
    expect(body.timetable['hours-of-day']).toHaveLength(24);
    expect(body.timetable['days-of-week']).toHaveLength(7);
  });

  it('creates one, with a 45-day deadline, when none is waiting', async () => {
    const { f, calls } = fakeCircle([{ id: 'other', name: 'nightly' }]);
    const now = Date.UTC(2026, 8, 24);
    await expect(ensureSchedule({ token: 't', slug: 'dmarket/p2p-extension', version: '1.0.7', now, fetch: f })).resolves.toEqual({
      outcome: 'created',
      id: 'new-id',
      until: '2026-11-08',
      deleted: [],
    });
    expect(calls).toEqual(['GET /project/gh/dmarket/p2p-extension/schedule', 'POST /project/gh/dmarket/p2p-extension/schedule']);
  });

  it('replaces a wait for an older version — creating first, so the release is never unwatched', async () => {
    const { f, calls } = fakeCircle([{ id: 'old', name: 'force-update-1.0.6' }]);
    const result = await ensureSchedule({ token: 't', slug: 's/r', version: '1.0.7', fetch: f });
    expect(result.deleted).toEqual(['old']);
    expect(calls).toEqual(['GET /project/gh/s/r/schedule', 'POST /project/gh/s/r/schedule', 'DELETE /schedule/old']);
  });

  it('keeps a wait for this version or a newer one and creates nothing', async () => {
    const { f, calls } = fakeCircle([{ id: 'newer', name: 'force-update-1.0.8' }]);
    await expect(ensureSchedule({ token: 't', slug: 's/r', version: '1.0.7', fetch: f })).resolves.toEqual({ outcome: 'kept', deleted: [] });
    expect(calls).toEqual(['GET /project/gh/s/r/schedule']);
  });

  it('follows the list across pages and ignores schedules it does not own', async () => {
    const pages = [
      { items: [{ id: 'a', name: 'force-update-1.0.6' }, { id: 'b', name: 'force-update-junk' }], next_page_token: 'p2' },
      { items: [{ id: 'c', name: 'something-else' }], next_page_token: null },
    ];
    const f = vi.fn(() => Promise.resolve(new Response(JSON.stringify(pages.shift()))));
    await expect(listForceSchedules({ token: 't', slug: 's/r', fetch: f })).resolves.toEqual([{ id: 'a', version: '1.0.6' }]);
    expect(f.mock.calls[1][0]).toContain('page-token=p2');
  });
});
