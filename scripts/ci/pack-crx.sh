#!/usr/bin/env bash
#
# pack-crx.sh <fetch|verify|pack|attach> — the four steps of the CircleCI `pack_crx` job.
#
# Takes the production zip published on the GitHub Release for this tag, re-verifies it, wraps it in a
# CRX3 signed with the Verified-CRX-Uploads key, and attaches that .crx to the same Release. The signed
# file is handed to `upload_to_store` through the CircleCI workspace (artifacts/store/).
#
# WHY A SEPARATE JOB FROM THE UPLOAD. It runs BEFORE the human approval, so the operator approves
# something already built, verified and signed — the approval decides only whether it goes to the store.
# The split is also meant to separate the secrets (this job the signing key, the other the store
# credentials), but that half is NOT in effect today: both live as project env vars because nobody has
# CircleCI org rights to create contexts. See the env note in .circleci/config.yml.
#
# Nothing is re-zipped: the CRX payload is the exact archive whose checksum the release job recorded, so
# what the store receives is byte-for-byte what was built, verified and published on the Release.
#
# Called as `bash scripts/ci/pack-crx.sh <step>` from .circleci/config.yml, one CircleCI step per
# subcommand so each shows up separately in the UI. The logic lives here rather than inline in the YAML
# because CircleCI caps a single config expression at 2048 characters, a YAML block scalar re-indents
# heredocs and hides quoting bugs that only surface at run time, and a real file can be run and reviewed
# as shell — `bash scripts/ci/pack-crx.sh verify` runs standalone.
#
# Environment:
#   REPO_SLUG            owner/repo (set by the executor in .circleci/config.yml)
#   GITHUB_TOKEN         contents:write — read the Release, attach the .crx (context org-global)
#   RELEASE_TAG          the tag to package, e.g. v1.0.1 — resolved below from CIRCLE_TAG when a tag
#                        pipeline runs this, otherwise from package.json (the release job in the same
#                        workflow has just tagged exactly that version)
#   CRX_SIGNING_KEY_B64  base64 of the RSA private key PEM registered under Package → Verified CRX
#                        Uploads. A CircleCI PROJECT env var today; it belongs in a project-scoped
#                        context (`p2p-extension-crx-signing`) once someone has the org rights — see
#                        the env note in .circleci/config.yml.
#   BASH_ENV             CircleCI's per-job env file, sourced before every step
set -euo pipefail

CMD="${1:-}"
: "${REPO_SLUG:?REPO_SLUG must be set (the CircleCI executor sets it)}"
: "${BASH_ENV:=/tmp/bash_env}"

API="https://api.github.com/repos/${REPO_SLUG}"
AUTH="Authorization: Bearer ${GITHUB_TOKEN:-}"
# Downloads and the unpacked tree; deliberately NOT the working directory — scripts/verify-build.mjs
# reads package.json from the CHECKOUT, so this job must stay there.
WORK="${WORK:-/tmp/deploy}"
# Staged for `store_artifacts` and `persist_to_workspace`; relative, because the workspace root is `.`.
STORE_DIR="artifacts/store"

# The tag to package. A tag pipeline supplies CIRCLE_TAG; inside the release workflow — where these
# jobs live now — there is none, so fall back to package.json. That is the same string `release.sh`
# tagged moments earlier in the same pipeline: it refuses to release unless the branch name,
# package.json and the changelog all agree, so the version in the file IS the tag. An explicit
# RELEASE_TAG wins over both, which is what makes the script runnable by hand against any release.
#
# Resolved here rather than in each subcommand because every CI step re-runs this file from scratch;
# there is no state to carry between them.
if [ -z "${RELEASE_TAG:-}" ]; then
  if [ -n "${CIRCLE_TAG:-}" ]; then
    RELEASE_TAG="$CIRCLE_TAG"
  elif [ -f package.json ]; then
    # Left empty rather than "v" on a failure, so `fetch`'s own :? guard reports the real situation
    # instead of chasing a release tagged "v".
    pkg_version="$(node -p "require('./package.json').version" 2> /dev/null || true)"
    [ -n "$pkg_version" ] && RELEASE_TAG="v$pkg_version"
  fi
fi

# ── fetch ─────────────────────────────────────────────────────────────────────────────────────────
fetch() {
  : "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (org-wide context org-global)}"
  : "${RELEASE_TAG:?RELEASE_TAG could not be resolved — no CIRCLE_TAG and no package.json version}"

  # Report every missing signing/store variable at once, by NAME, so one failed run tells the operator
  # the whole list instead of one name per re-run. Values are never printed anywhere in this file.
  local missing=""
  [ -n "${CRX_SIGNING_KEY_B64:-}" ] || missing="$missing CRX_SIGNING_KEY_B64"
  if [ -n "$missing" ]; then
    echo "ERROR: missing environment:$missing — set it in CircleCI Project Settings ->" >&2
    echo "       Environment Variables (see the env note in .circleci/config.yml)." >&2
    return 1
  fi

  local version zip
  version="${RELEASE_TAG#v}"
  zip="dmarket-p2p-extension-${version}-chrome.zip"

  rm -rf "$WORK"
  mkdir -p "$WORK" "$STORE_DIR"

  curl -sSf -H "$AUTH" "$API/releases/tags/$RELEASE_TAG" > "$WORK/release.json"
  # The zip and SHA256SUMS by asset id. Named explicitly rather than "every asset": the set is then the
  # same on every run, and a file that appears on the Release for any other reason cannot be pulled in.
  node -e '
    const r = require(process.argv[1]);
    const lines = [];
    for (const name of [process.argv[2], "SHA256SUMS"]) {
      const a = (r.assets ?? []).find((x) => x.name === name);
      if (!a) {
        console.error(`ERROR: release ${r.tag_name} has no asset "${name}".`);
        process.exit(1);
      }
      lines.push(`${a.id} ${a.name}`);
    }
    require("fs").writeFileSync(process.argv[3], lines.join("\n") + "\n");
  ' "$WORK/release.json" "$zip" "$WORK/assets.txt"

  while read -r ID NAME; do
    curl -sSfL -H "$AUTH" -H "Accept: application/octet-stream" "$API/releases/assets/$ID" -o "$WORK/$NAME"
  done < "$WORK/assets.txt"

  # --ignore-missing: SHA256SUMS also covers the assets this job has no reason to download.
  ( cd "$WORK" && sha256sum -c --ignore-missing SHA256SUMS )

  {
    echo "export VERSION='$version'"
    echo "export ZIP='$zip'"
    echo "export CRX='dmarket-p2p-extension-${version}-chrome.crx'"
  } >> "$BASH_ENV"
  echo "Fetched $zip for $RELEASE_TAG (checksum verified)."
}

# ── verify ────────────────────────────────────────────────────────────────────────────────────────
verify() {
  if ! command -v unzip > /dev/null; then
    echo "ERROR: unzip is not installed in this executor image — needed to check the package before signing." >&2
    return 1
  fi
  rm -rf "$WORK/unpacked"
  unzip -q "$WORK/$ZIP" -d "$WORK/unpacked"

  # The same guard the build and release jobs run, now against the bytes actually downloaded from the
  # Release. --require-derived-hosts because the collector and Firebase host permissions are derived
  # from build-time variables: a build that missed its context must never reach the store, where adding
  # a host permission later disables the extension for every user until they re-consent.
  node scripts/verify-build.mjs "$WORK/unpacked" --mode production --require-derived-hosts

  # The version the STORE sees. WXT splits a prerelease version (1.0.0-beta.1 → version 1.0.0 +
  # version_name), so this is not $VERSION and the difference is exactly what CWS compares against the
  # published version. The upload job reads it from the workspace and needs no checkout of its own.
  mkdir -p "$STORE_DIR"
  node -p "require('$WORK/unpacked/manifest.json').version" > "$STORE_DIR/VERSION"
  # The release version WITH any prerelease suffix, i.e. the tag. Persisted next to VERSION because the
  # two differ exactly for a beta (`v1.1.0-beta.1` -> manifest `1.1.0`), and the upload job's decision
  # about whether this may go to the store depends on the suffix that VERSION no longer has.
  printf '%s\n' "$VERSION" > "$STORE_DIR/RELEASE_VERSION"
  echo "Package verified. Manifest version $(cat "$STORE_DIR/VERSION"), release $VERSION (tag $RELEASE_TAG)."
}

# ── pack ──────────────────────────────────────────────────────────────────────────────────────────
pack() {
  mkdir -p "$STORE_DIR"
  node scripts/ci/pack-crx.mjs pack "$WORK/$ZIP" "$STORE_DIR/$CRX"
  # Checksums over what the upload job will send, so the two jobs can be compared in their logs.
  ( cd "$STORE_DIR" && sha256sum "$CRX" VERSION RELEASE_VERSION > SHA256SUMS )
  cat "$STORE_DIR/SHA256SUMS"
}

# ── attach ────────────────────────────────────────────────────────────────────────────────────────
attach() {
  : "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (org-wide context org-global)}"

  # Always attached, unconditionally: the .crx IS the signed release artifact, and it is the exact
  # bytes the store will receive, so the Release is where it belongs whether or not anyone goes on to
  # approve the upload. (There used to be a CWS_DRY_RUN branch skipping this; the rehearsal is now the
  # `store_preflight` job, which cannot upload at all, so there is nothing left to keep off a Release.)
  # The release id, whether the .crx is already there, and the SHA256SUMS asset id — one pass over the
  # payload `fetch` already downloaded. The two writes below are INDEPENDENTLY idempotent rather than
  # sharing one early return, so a run that attached the .crx and then died still fixes the checksums
  # when it is re-run.
  node -e '
    const r = require(process.argv[1]);
    const assets = r.assets ?? [];
    const sums = assets.find((a) => a.name === "SHA256SUMS");
    process.stdout.write(
      `${r.id ?? ""}\n${assets.some((a) => a.name === process.argv[2]) ? "yes" : "no"}\n${sums?.id ?? ""}\n`,
    );
  ' "$WORK/release.json" "$CRX" > "$WORK/attach.txt"
  local release_id crx_attached sums_id
  release_id="$(sed -n 1p "$WORK/attach.txt")"
  crx_attached="$(sed -n 2p "$WORK/attach.txt")"
  sums_id="$(sed -n 3p "$WORK/attach.txt")"

  if [ -z "$release_id" ]; then
    echo "ERROR: could not read the release id from $WORK/release.json." >&2
    return 1
  fi

  if [ "$crx_attached" = "yes" ]; then
    echo "$CRX is already attached to $RELEASE_TAG — leaving it alone."
  else
    echo "Uploading ${CRX}…"
    curl -sSf -X POST -H "$AUTH" -H "Content-Type: application/octet-stream" \
      --data-binary @"$STORE_DIR/$CRX" \
      "https://uploads.github.com/repos/${REPO_SLUG}/releases/${release_id}/assets?name=${CRX}" \
      -o /dev/null
    echo "Attached $CRX to https://github.com/${REPO_SLUG}/releases/tag/${RELEASE_TAG}"
  fi

  cover_crx_in_checksums "$release_id" "$sums_id"
}

# The Release's SHA256SUMS is written by release.sh, in a job that runs BEFORE this one — so it cannot
# cover the .crx, while the release notes promise it covers every attachment. Rewriting it here is what
# keeps that promise true; a verifier should not have to dig a checksum out of a CI log.
#
# GitHub cannot append to an asset, so the old one is deleted and a new one uploaded under the same
# name. The window between the two is the cost, and it is bounded: a partial run leaves the Release
# without SHA256SUMS, which makes `fetch` fail loudly on the next run ("release … has no asset
# SHA256SUMS") rather than quietly producing a release nobody can verify.
cover_crx_in_checksums() {
  local release_id="$1" sums_id="$2"

  if [ -z "$sums_id" ]; then
    # Unreachable in practice — `fetch` names SHA256SUMS as a required asset and fails without it — so
    # this is a guard, not a path. Publishing a SHA256SUMS covering only the .crx would be worse than
    # publishing none: it would read as "verified" while covering one file in five.
    echo "WARNING: $RELEASE_TAG has no SHA256SUMS asset; leaving checksums alone." >&2
    return 0
  fi

  # $WORK/SHA256SUMS is the Release's own file as downloaded by `fetch` THIS run, so on a re-run it
  # already carries the line and this is the whole idempotency check — no second download needed.
  if grep -qF -- "  $CRX" "$WORK/SHA256SUMS"; then
    echo "SHA256SUMS already covers $CRX — leaving it alone."
    return 0
  fi

  # Computed from the file that was uploaded. Deliberately not copied out of $STORE_DIR/SHA256SUMS:
  # that one also covers VERSION and RELEASE_VERSION, which are workspace plumbing, not Release assets.
  cp "$WORK/SHA256SUMS" "$WORK/SHA256SUMS.new"
  ( cd "$STORE_DIR" && sha256sum "$CRX" ) >> "$WORK/SHA256SUMS.new"

  curl -sSf -X DELETE -H "$AUTH" "$API/releases/assets/$sums_id" -o /dev/null
  curl -sSf -X POST -H "$AUTH" -H "Content-Type: application/octet-stream" \
    --data-binary @"$WORK/SHA256SUMS.new" \
    "https://uploads.github.com/repos/${REPO_SLUG}/releases/${release_id}/assets?name=SHA256SUMS" \
    -o /dev/null
  echo "SHA256SUMS updated to cover $CRX:"
  sed 's/^/  /' "$WORK/SHA256SUMS.new"
}

case "$CMD" in
  fetch) fetch ;;
  verify) verify ;;
  pack) pack ;;
  attach) attach ;;
  *)
    echo "usage: bash scripts/ci/pack-crx.sh <fetch|verify|pack|attach>" >&2
    exit 2
    ;;
esac
