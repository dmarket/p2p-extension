#!/usr/bin/env bash
#
# upload-to-store.sh <preflight|upload> — the Chrome Web Store half of the tag pipeline.
#
#   preflight          a full REHEARSAL: everything the upload decides, deciding nothing. Runs
#                      automatically in the `store_preflight` job, BEFORE the human approval, so
#                      whoever clicks Approve already knows what the store holds and whether this
#                      version would be accepted. Read-only — it cannot upload or publish.
#   upload [flags…]    the real thing, in `upload_to_store`, after the approval. Extra flags are
#                      forwarded to cws-upload.mjs; `--cancel-pending` and `--skip-publish` exist for
#                      a deliberate SSH rerun and are not wired into the config.
#
# WHY A JOB AND NOT A DRY-RUN VARIABLE. The rehearsal used to be `CWS_DRY_RUN=true` in CircleCI's
# project settings, which is STATE: it applies to every later run until someone remembers to remove it,
# so a forgotten flag silently stops releases from ever reaching the store while the log cheerfully
# says "DRY RUN". As a job it is stateless, it runs on every release without anyone arranging it, and
# it lands where it is useful — before the decision rather than instead of it. Nothing uploads without
# a click, which is what made the variable unnecessary in the first place.
#
# It uploads the CRX that `pack_crx` signed, handed over through the workspace (artifacts/store/). It
# needs no GITHUB_TOKEN of its own, and it is meant to hold only the store credentials — but that
# isolation is NOT in effect today: the secrets are project env vars, visible to every job, because
# nobody has CircleCI org rights to create contexts. See the env note in .circleci/config.yml.
#
# Shell lives in a file rather than inline in the YAML: CircleCI caps a config expression at 2048
# characters, and `bash scripts/ci/upload-to-store.sh preflight` can be run and reviewed as shell.
#
# Environment (see scripts/ci/cws-upload.mjs for the full contract):
#   CHROME_EXTENSION_ID, CHROME_PUBLISHER_ID,
#   CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL, CHROME_SERVICE_ACCOUNT_PRIVATE_KEY
#     — CircleCI PROJECT env vars today; they belong in a project-scoped context
#       (`p2p-extension-store`) once someone has the org rights. See .circleci/config.yml.
#
# Betas are ordinary public releases here — a `-beta` suffix is a LABEL for users' expectations, not a
# channel, and the store has no beta channel anyway (API v2's DistributionChannel carries only
# deployPercentage and crxVersion). So a prerelease version is uploaded like any other; what it must
# not do is reuse a numeric version, since the store compares `manifest.version` with the suffix
# already dropped. cws-upload.mjs refuses that (exit 3) before uploading anything.
#
# Exit codes are scripts/ci/cws-upload.mjs's: 0 ok, 1 HTTP, 2 env, 3 version not greater, 4 pending
# review, 5 upload failed, 6 publish rejected.
set -euo pipefail

CMD="${1:-}"
shift || true
STORE_DIR="artifacts/store"

require_env() {
  local missing=""
  for name in CHROME_EXTENSION_ID CHROME_PUBLISHER_ID CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL CHROME_SERVICE_ACCOUNT_PRIVATE_KEY; do
    eval "value=\${$name:-}"
    [ -n "$value" ] || missing="$missing $name"
  done
  if [ -n "$missing" ]; then
    echo "ERROR: missing environment:$missing — set it in CircleCI Project Settings ->" >&2
    echo "       Environment Variables (see the env note in .circleci/config.yml)." >&2
    return 1
  fi
}

# The signed package and the two versions `pack_crx` recorded. RELEASE_VERSION carries any prerelease
# suffix; VERSION is what the store compares, with the suffix already dropped by WXT. The two differ
# exactly for a beta, which is the one place that distinction bites.
CRX=""
VERSION=""
RELEASE=""
load_workspace() {
  if [ ! -f "$STORE_DIR/SHA256SUMS" ]; then
    echo "ERROR: $STORE_DIR is empty — the pack_crx job's workspace was not attached." >&2
    return 1
  fi
  # Cheap, and it prints the same hash pack_crx logged, so the jobs can be compared at a glance.
  ( cd "$STORE_DIR" && sha256sum -c SHA256SUMS )
  CRX="$(ls "$STORE_DIR"/*.crx)"
  VERSION="$(cat "$STORE_DIR/VERSION")"
  RELEASE="$(cat "$STORE_DIR/RELEASE_VERSION" 2> /dev/null || echo "$VERSION")"
}

banner() {
  local suffix_note=""
  [ "$RELEASE" != "$VERSION" ] && suffix_note="   (suffix dropped by WXT — this is what the store compares)"
  cat << BANNER

==================================================================
  ${1}
==================================================================
  tag              : ${CIRCLE_TAG:-v$RELEASE}
  release version  : ${RELEASE}
  manifest version : ${VERSION}${suffix_note}
  package          : $(basename "$CRX")
  sha256           : $(sha256sum "$CRX" | cut -d' ' -f1)
  dashboard        : https://chrome.google.com/webstore/devconsole/${CHROME_PUBLISHER_ID}/${CHROME_EXTENSION_ID}/edit/package
==================================================================

BANNER
}

# ── preflight ─────────────────────────────────────────────────────────────────────────────────────
#
# Proves the credentials, the publisher/item ids and the API enablement, prints what the store
# currently holds, and applies every refusal the real upload would apply — a version the store would
# reject (exit 3), a submission already pending review (exit 4) — while uploading nothing. So a wrong
# id, a service account never added under Developer Dashboard → Account, or a version that only bumped
# a suffix all fail HERE, before anyone is asked to approve a release that could not have worked.
preflight() {
  require_env
  load_workspace
  node scripts/ci/cws-upload.mjs deploy "$CRX" --version "$VERSION" --dry-run
  banner "REHEARSAL PASSED — approve hold_store_upload to submit this for review"
}

# ── upload ────────────────────────────────────────────────────────────────────────────────────────
upload() {
  require_env
  load_workspace

  set +e
  node scripts/ci/cws-upload.mjs deploy "$CRX" --version "$VERSION" "$@"
  local code=$?
  set -e

  local headline
  if [ "$code" -ne 0 ]; then
    headline="FAILED (exit $code — see scripts/ci/cws-upload.mjs for what each code means)"
  elif [ "$*" != "${*/--skip-publish/}" ]; then
    headline="DRAFT UPLOADED — submit it for review in the dashboard"
  else
    headline="SUBMITTED FOR REVIEW"
  fi
  banner "$headline"
  return "$code"
}

case "$CMD" in
  preflight) preflight ;;
  upload) upload "$@" ;;
  *)
    echo "usage: bash scripts/ci/upload-to-store.sh <preflight|upload [flags…]>" >&2
    exit 2
    ;;
esac
