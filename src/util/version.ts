// Chrome extension versions: what the store, Chrome's update server and `manifest.version` speak.
//
// 1 to 4 dot-separated integers, each 0..65535, no leading zeros required, no suffix. A package version such
// as `1.0.6-beta` is NOT one: WXT puts its numeric part in `manifest.version` and the full string in
// `manifest.version_name`. Anything comparing against the store or the update server must therefore compare
// the numeric part only — which is also why `web.minExtensionVersion` takes the numeric form alone.

const PART_MAX = 65_535;

/** `true` for a version Chrome accepts in `manifest.version` (`1`, `1.0`, `1.0.6`, `1.0.6.2`). */
export function isChromeVersion(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,5}(\.\d{1,5}){0,3}$/.test(value)) return false;
  return value.split('.').every((part) => Number(part) <= PART_MAX);
}

/** The numeric part of a package or display version: `1.0.6-beta` → `1.0.6`. */
export function numericVersion(version: string): string {
  return version.split('-', 1)[0] ?? version;
}

/** -1 / 0 / 1. Missing parts count as 0, so `1.0` equals `1.0.0`. Both sides must be numeric versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
