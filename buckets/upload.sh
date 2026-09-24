#!/bin/bash
# Publish buckets/<env>/p2p/extension-config.json. Usage: buckets/upload.sh stage|prod [--yes]
#
# Validates the file first, shows the diff against what is live, asks before touching prod, and uploads with
# `--if-generation-match` so a change someone else published after the diff is never overwritten.
. "$(dirname "$0")/common.sh"

env="${1:?usage: buckets/upload.sh stage|prod [--yes]}"
yes="${2:-}"
bucket="$(bucket_for "$env")"
src="$(local_for "$env")"
dst="gs://$bucket/$OBJECT"

npx vitest run src/config/bucketConfig.test.ts --reporter=dot >/dev/null || {
  echo "$src failed validation — run: npx vitest run src/config/bucketConfig.test.ts" >&2
  exit 1
}

generation="$(gcloud storage objects describe "$dst" --format='value(generation)' 2>/dev/null || true)"
if [ -n "$generation" ]; then
  live="$(mktemp)"
  trap 'rm -f "$live"' EXIT
  gcloud storage cp "$dst" "$live" --quiet
  if diff -q "$live" "$src" >/dev/null; then
    echo "$env: $dst is already up to date"
    exit 0
  fi
  diff -u --label "live $dst" --label "local $src" "$live" "$src" || true
else
  generation=0
  echo "$env: $dst does not exist yet — it will be created"
fi

if [ "$env" = prod ] && [ "$yes" != '--yes' ]; then
  read -r -p 'Publish to PROD? Type "prod" to confirm: ' answer
  [ "$answer" = prod ] || { echo 'aborted'; exit 1; }
fi

gcloud storage cp "$src" "$dst" \
  --if-generation-match="$generation" \
  --cache-control='public, max-age=300' \
  --content-type='application/json'
echo "$env: published $dst"
