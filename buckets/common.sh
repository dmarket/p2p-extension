# Shared by the bucket scripts. Sourced, not run.
#
# These scripts touch exactly ONE object per bucket, `p2p/extension-config.json`. The buckets are shared with
# the frontend (and the Android/iOS scripts `rsync -d` whole buckets of their own), so nothing here may list,
# sync or delete anything else.

set -euo pipefail
cd "$(dirname "$0")/.."

OBJECT='p2p/extension-config.json'
PROD_BUCKET='cdn-main-dmarket-com'

# The stage bucket's name carries an internal hostname, so it lives in the gitignored .env (see .env.example).
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a && . ./.env && set +a
fi

bucket_for() {
  case "$1" in
    prod) echo "$PROD_BUCKET" ;;
    stage)
      : "${REMOTE_CONFIG_STAGE_BUCKET:?set REMOTE_CONFIG_STAGE_BUCKET in .env (see .env.example)}"
      echo "$REMOTE_CONFIG_STAGE_BUCKET"
      ;;
    *)
      echo "unknown environment '$1' (expected: stage | prod)" >&2
      exit 2
      ;;
  esac
}

local_for() { echo "buckets/$1/$OBJECT"; }
