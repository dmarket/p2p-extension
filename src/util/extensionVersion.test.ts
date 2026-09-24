import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { extensionVersion } from './extensionVersion';

function manifest(fields: { version: string; version_name?: string }) {
  vi.spyOn(fakeBrowser.runtime, 'getManifest').mockReturnValue({ manifest_version: 3, name: 'x', ...fields });
}

describe('extensionVersion', () => {
  it('reports the prerelease a beta build really is', () => {
    // What WXT emits for package version 1.0.5-beta.
    manifest({ version: '1.0.5', version_name: '1.0.5-beta' });
    expect(extensionVersion()).toBe('1.0.5-beta');
  });

  it('falls back to version for a release build, where WXT omits version_name', () => {
    manifest({ version: '1.1.0' });
    expect(extensionVersion()).toBe('1.1.0');
  });
});
