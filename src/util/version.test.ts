import { describe, expect, it } from 'vitest';
import { compareVersions, isChromeVersion, numericVersion } from './version';

describe('Chrome extension versions', () => {
  it('accepts 1-4 integer parts up to 65535 and nothing else', () => {
    for (const ok of ['1', '1.0', '1.0.6', '1.0.6.2', '65535.0']) expect(isChromeVersion(ok), ok).toBe(true);
    for (const bad of ['', '1.0.6-beta', '1.0.6.2.1', '65536', 'v1.0', '1..0', ' 1.0', 106, null]) {
      expect(isChromeVersion(bad), String(bad)).toBe(false);
    }
  });

  it('strips the display label down to what the store compares', () => {
    expect(numericVersion('1.0.6-beta')).toBe('1.0.6');
    expect(numericVersion('1.0.6')).toBe('1.0.6');
  });

  it('compares numerically, part by part, with missing parts as 0', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.5', '1.0.6')).toBe(-1);
    expect(compareVersions('2', '1.99.99')).toBe(1);
  });
});
