#!/usr/bin/env bash
#
# verify-store.sh <tag> — the `verify_store` job: is the release in the store really the release we built?
#
# Reads what the public update server serves, refuses to go on unless that is the version of <tag>, downloads
# that CRX and runs verify-crx.sh against the tag. Holds no store or signing credential: the update server needs
# no authentication, so this job can run long after the release without anyone's secrets.
#
# The store lists `manifest.version` (WXT drops a `-beta` suffix), so `v1.0.6-beta` is expected as `1.0.6`.
# A store review that has not finished yet serves the previous version, and that is reported as "not live yet"
# (exit 3) rather than as a mismatch — re-run once the store has published it.
set -euo pipefail

TAG=${1:?git tag, e.g. v1.0.6-beta}
WANT=${TAG#v}; WANT=${WANT%%-*}
DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT

SERVED=$(bash "$(dirname "$0")/cws-served-version.sh")
echo "$SERVED"
# The response opens with the XML declaration's own version="1.0"; the update check is the last match.
field() { printf '%s\n' "$SERVED" | sed -n "s/^$1=\"\\(.*\\)\"$/\\1/p" | tail -n1; }

GOT=$(field version)
if [ "$GOT" != "$WANT" ]; then
  echo "verify-store: the store serves ${GOT:-nothing}, $TAG is $WANT — not live yet (or superseded)." >&2
  exit 3
fi

curl -fsSL -o "$DIR/store.crx" "$(field codebase)"
EXPECTED=$(field hash_sha256)
ACTUAL=$( (sha256sum "$DIR/store.crx" 2>/dev/null || shasum -a 256 "$DIR/store.crx") | cut -d' ' -f1)
[ -z "$EXPECTED" ] || [ "$EXPECTED" = "$ACTUAL" ] \
  || { echo "verify-store: the downloaded CRX has sha256 $ACTUAL, the update server announced $EXPECTED" >&2; exit 1; }

git fetch -q --tags origin
bash "$(dirname "$0")/verify-crx.sh" "$DIR/store.crx" "$TAG" "$(pwd)"
