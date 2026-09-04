#!/usr/bin/env bash
#
# collect-artifacts.sh <production|development> — stage the build job's output under artifacts/ for
# `store_artifacts` (downloadable per push) and `persist_to_workspace` (the release job's input).
#
# Called as `bash scripts/ci/collect-artifacts.sh <mode>` from .circleci/config.yml. Lives here
# rather than inline in the YAML for the same reasons as release.sh: CircleCI caps a config
# expression at 2048 characters, and shell in a real file can be run and reviewed as shell.
#
# Both build jobs write into the same artifacts/ directory and CircleCI merges their workspace
# contributions; the filenames never collide (production has no `-dev` suffix, and only production
# emits the sourcemaps archive and the manifest copy).
set -euo pipefail

MODE="${1:?usage: bash scripts/ci/collect-artifacts.sh <production|development>}"
VERSION="$(node -p "require('./package.json').version")"

case "$MODE" in
  production) SUFFIX="" ;;
  development) SUFFIX="-dev" ;;
  *)
    echo "ERROR: unknown mode '$MODE' (expected production or development)." >&2
    exit 2
    ;;
esac

mkdir -p artifacts

# Named explicitly rather than `mv .output/*.zip` — WXT's artifactTemplate is
# `{{name}}-{{packageVersion}}-{{browser}}{{modeSuffix}}.zip`, so this is deterministic, it FAILS if
# the zip we expect is not there, and it cannot sweep up an unrelated artifact (a stale firefox or
# sources zip from an earlier local build, say) and attach it to a release.
mv ".output/dmarket-p2p-extension-${VERSION}-chrome${SUFFIX}.zip" artifacts/

if [ "$MODE" = "production" ]; then
  # The manifest travels to the release job as its own file so that job can re-check the privilege
  # surface without unpacking a zip (and without node_modules).
  cp .output/chrome-mv3/manifest.json artifacts/manifest.chrome.json

  # `sourcemap: 'hidden'` emits maps with no sourceMappingURL — nothing points at them, and a crash
  # report's frames are unreadable without them (background.js is ~1.2 MB on ~57 lines). Archive them
  # per release to symbolicate. Upstream's own maps under pkg/ and transport/ are excluded: they
  # belong to the vendored prover, not to our bundle.
  MAPS=/tmp/sourcemaps.txt
  ( cd .output/chrome-mv3 && find . -name '*.map' -not -path './pkg/*' -not -path './transport/*' > "$MAPS" )
  tar -czf "artifacts/dmarket-p2p-extension-${VERSION}-chrome-sourcemaps.tar.gz" \
    -C .output/chrome-mv3 -T "$MAPS"
fi

ls -lh artifacts
