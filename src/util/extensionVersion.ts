/**
 * The extension's own version as the user sees it: `version_name` when the build carries a prerelease
 * suffix, `version` otherwise.
 *
 * WXT splits a package version such as `1.0.5-beta` across two manifest fields — the numeric `1.0.5` in
 * `version` (Chrome accepts only integers there) and the full string in `version_name`, which it omits
 * when the two would be equal. Reading `version` alone would report every beta as the release it
 * precedes.
 *
 * This is the version sent to the backend (the heartbeat's `clientVersion`) and to dmarket.com (the
 * pong's `version`). The core version is not sent separately: each extension build pins exactly one core,
 * so it follows from this.
 */
export function extensionVersion(): string {
  const manifest = browser.runtime.getManifest();
  return manifest.version_name ?? manifest.version;
}
