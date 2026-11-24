import { describe, expect, it } from 'vitest';
import { parseIssuance } from '@/debug/protocol';

describe('parseIssuance', () => {
  it('accepts the three pairings the core accepts', () => {
    expect(parseIssuance({ mode: 'mpc', transport: 'direct' })).toEqual({ mode: 'mpc', transport: 'direct' });
    expect(parseIssuance({ mode: 'proxy', transport: 'direct' })).toEqual({ mode: 'proxy', transport: 'direct' });
    expect(parseIssuance({ mode: 'proxy', transport: 'egress' })).toEqual({ mode: 'proxy', transport: 'egress' });
  });

  it('refuses egress without proxy, which would make the core constructor throw', () => {
    expect(parseIssuance({ mode: 'mpc', transport: 'egress' })).toBeUndefined();
  });

  it('refuses anything else', () => {
    for (const v of [undefined, null, '', 'proxy', { mode: 'proxy' }, { mode: 'PROXY', transport: 'direct' }]) {
      expect(parseIssuance(v)).toBeUndefined();
    }
  });
});
