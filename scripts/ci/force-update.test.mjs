import { describe, expect, it, vi } from 'vitest';
import {
  gcsGet,
  gcsPut,
  parseServedVersion,
  raiseMinimum,
  servedVersion,
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
