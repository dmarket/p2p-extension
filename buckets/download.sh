#!/bin/bash
# Pull the published extension config into buckets/<env>/. Usage: buckets/download.sh [stage|prod|all]
. "$(dirname "$0")/common.sh"

envs="${1:-all}"
[ "$envs" = all ] && envs='stage prod'
for env in $envs; do
  src="gs://$(bucket_for "$env")/$OBJECT"
  dst="$(local_for "$env")"
  mkdir -p "$(dirname "$dst")"
  gcloud storage cp "$src" "$dst"
  echo "$env: $src -> $dst"
done
