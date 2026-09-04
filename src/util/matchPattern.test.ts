import { describe, expect, it } from 'vitest';
import { endpointMatchPattern, originMatchPattern } from '@/util/matchPattern';

// These two build every `host_permissions` entry derived from a configured URL (wxt.config.ts), so the
// shape of the string IS the contract — Chrome enforces a host permission against the whole URL, path
// included, and a pattern that is subtly wrong fails only in a real browser, as CORS or a dead
// integration long after the build. The other half of the contract is that neither may THROW or widen on
// a bad value: they are handed raw `.env` variables inside the manifest hook.

describe('endpointMatchPattern', () => {
  it('narrows to the endpoint path and keeps a query matching', () => {
    expect(endpointMatchPattern('https://t.dmarket.com/v1/collect')).toBe(
      'https://t.dmarket.com/v1/collect*',
    );
  });

  it('degenerates to the whole origin when the URL names no path', () => {
    expect(endpointMatchPattern('https://t.dmarket.com')).toBe('https://t.dmarket.com/*');
    expect(endpointMatchPattern('https://t.dmarket.com/')).toBe('https://t.dmarket.com/*');
  });

  it('drops the query and fragment of the configured URL', () => {
    // They belong to the request, not to the grant — and `?` is not a match-pattern character.
    expect(endpointMatchPattern('https://t.dmarket.com/v1/collect?x=1#f')).toBe(
      'https://t.dmarket.com/v1/collect*',
    );
  });

  it('keeps a non-default port, which is part of the pattern', () => {
    expect(endpointMatchPattern('http://localhost:8787/v1/collect')).toBe(
      'http://localhost:8787/v1/collect*',
    );
  });

  it('trims surrounding whitespace, which an .env value can carry', () => {
    expect(endpointMatchPattern('  https://t.dmarket.com/v1/collect  ')).toBe(
      'https://t.dmarket.com/v1/collect*',
    );
  });
});

describe('originMatchPattern', () => {
  it('takes the whole origin and discards path, query and fragment', () => {
    // The breadth for a site reached at many paths — and whose paths are remote-config-tunable, so
    // anything narrower would have to be kept in step with every path the code might use.
    expect(originMatchPattern('https://dmarket.com')).toBe('https://dmarket.com/*');
    expect(originMatchPattern('https://dmarket.com/deep/link?x=1#f')).toBe('https://dmarket.com/*');
  });

  it('keeps a non-default port, which is part of the origin', () => {
    expect(originMatchPattern('http://localhost:3000/')).toBe('http://localhost:3000/*');
  });
});

describe('both breadths, on a value that is not usable', () => {
  // Neither may throw and neither may widen. The origin form used to do the first: it was an unguarded
  // `new URL(url).origin` inside the manifest hook, so a typo in any of the five dev/stage variables it
  // serves aborted the build with a bare `TypeError` naming neither the variable nor the value — while
  // the endpoint form silently contributed nothing, and a comment claimed the two agreed.
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['not a URL', 'not a url'],
    ['path-only', '/v1/collect'],
    ['scheme-only', 'https://'],
  ])('answers undefined for a %s value rather than throwing or widening', (_label, value) => {
    expect(originMatchPattern(value)).toBeUndefined();
    expect(endpointMatchPattern(value)).toBeUndefined();
  });
});
