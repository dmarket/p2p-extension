#!/usr/bin/env bash
#
# verify-crx.sh <file.crx|file.zip> <git-tag> [path-to-checkout] — does the package in the store match what
# this repository builds from the tag?
#
# Steps:
#   1. Unpack the package. A CRX3 is "Cr24" + version + header length + header + zip, so the header is stripped.
#   2. `git worktree add` on the tag, `npm ci`, `npx wxt build --mode production`. The build needs the same
#      WXT_* variables as CI's build-prod (project env vars): without WXT_COLLECTOR_URL the manifest
#      carries different host_permissions, and that shows up here as a mismatch, not as an error.
#   3. Compare (a) the sha256 of every file, ignoring what legitimately differs: `_metadata/` (the store adds
#      verified_contents.json), `*.map` (`wxt zip` leaves sourcemaps out, `wxt build` does not) and
#      manifest.json, which the store rewrites by adding `update_url` and is compared separately without it;
#      (b) the privilege surface of the manifest; (c) every https:// host literal in the bundle.
#
# Exit status: 0 only when all three comparisons are identical, 1 on any difference, 2 on bad usage.
set -euo pipefail

PKG=${1:?crx or zip}; TAG=${2:?git tag, e.g. v1.0.5-beta}; SRC=${3:-$(pwd)}
for tool in jq unzip python3 git npm; do
  command -v "$tool" >/dev/null || { echo "verify-crx: $tool is required" >&2; exit 2; }
done
if command -v sha256sum >/dev/null; then SHA=sha256sum; else SHA='shasum -a 256'; fi

TMP=$(mktemp -d); A=$TMP/store; B=$TMP/build; mkdir -p "$A" "$B"
trap 'git -C "$SRC" worktree remove --force "$TMP/wt" 2>/dev/null || true; rm -rf "$TMP"' EXIT
FAILED=0

# --- 1. unpack the store package ---------------------------------------------------------------
if head -c 4 "$PKG" | grep -q Cr24; then
  python3 -I - "$PKG" "$A/pkg.zip" <<'PY'
import struct, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src, 'rb') as f:
    magic, version, hlen = struct.unpack('<4sII', f.read(12))
    assert magic == b'Cr24' and version == 3, f'not a CRX3: {magic} v{version}'
    f.seek(12 + hlen)
    open(dst, 'wb').write(f.read())
print(f'crx3 header {hlen} bytes stripped')
PY
  unzip -q "$A/pkg.zip" -d "$A/unpacked"
else
  unzip -q "$PKG" -d "$A/unpacked"
fi

# --- 2. reproducible build on the tag -----------------------------------------------------------
git -C "$SRC" worktree add --detach "$TMP/wt" "$TAG" >/dev/null
( cd "$TMP/wt" && npm ci --no-audit --no-fund >/dev/null && npx wxt build --mode production >/dev/null )
cp -R "$TMP/wt/.output/chrome-mv3" "$B/unpacked"

# --- 3. compare -----------------------------------------------------------------------------------
hashes() { ( cd "$1" && find . -type f ! -path './_metadata/*' ! -name '*.map' ! -name manifest.json -print0 | sort -z | xargs -0 $SHA ); }
manifest() { jq -S 'del(.update_url)' "$1/manifest.json"; }
perm() { jq -S '{version, permissions, host_permissions, optional_host_permissions, content_scripts: [.content_scripts[]?.matches], web_accessible_resources, externally_connectable}' "$1/manifest.json"; }
hosts() { grep -rhoE 'https?://[a-zA-Z0-9.-]+\.[a-z]{2,}' "$1" --include='*.js' --include='*.html' --include='*.json' | sort -u; }

echo "== file hashes (store vs build on $TAG)"
diff <(hashes "$A/unpacked") <(hashes "$B/unpacked") && echo "IDENTICAL" || FAILED=1
echo "== manifest.json without update_url"
diff <(manifest "$A/unpacked") <(manifest "$B/unpacked") && echo "IDENTICAL" || FAILED=1
echo "== manifest privilege surface"
diff <(perm "$A/unpacked") <(perm "$B/unpacked") && echo "IDENTICAL" || FAILED=1
echo "== hosts referenced in the bundle"
diff <(hosts "$A/unpacked") <(hosts "$B/unpacked") && echo "IDENTICAL" || FAILED=1
echo "store hosts:"; hosts "$A/unpacked" | sed 's/^/  /'

[ "$FAILED" = 0 ] && echo "verify-crx: the store package matches $TAG" || { echo "verify-crx: the store package DIFFERS from $TAG" >&2; exit 1; }
