#!/usr/bin/env bash
#
# delete-release-branch.sh — the CircleCI `delete_release_branch` job: the last step of a release. Once
# the release is tagged, published and submitted to the store, the `release/vX.Y.Z` branch has done its
# job, and it is deleted so the branch list holds only releases still in progress.
#
# Called as `bash scripts/ci/delete-release-branch.sh` from .circleci/config.yml. Lives here rather than
# inline in the YAML for the same reasons as release.sh.
#
# Nothing is lost by the deletion: the released commit stays reachable from its tag `v<version>`. The
# branch is NOT merged anywhere — the version bump and the CHANGELOG section land on `main` through a
# pull request before the branch is cut (README, "Cutting a release"), so the branch carries no commit
# `main` needs.
#
# CONTRACT: exits 0 when there is nothing to delete — the push released nothing (no tag on this
# branch's history), or the branch is already gone — and non-zero only when a released branch could not
# be deleted. A branch that released nothing is always kept.
#
# Environment:
#   REPO_SLUG      owner/repo (set by the executor in .circleci/config.yml)
#   GITHUB_TOKEN   contents:write — the same credential `release` pushes the tag with
#   CIRCLE_BRANCH  the release branch (`release/vX.Y.Z`)
#   CIRCLE_SHA1    the commit this pipeline built and released
set -euo pipefail

: "${REPO_SLUG:?REPO_SLUG must be set (the CircleCI executor sets it)}"
: "${CIRCLE_BRANCH:?CIRCLE_BRANCH must be set — this job runs on release branches only}"
: "${CIRCLE_SHA1:?CIRCLE_SHA1 must be set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (org-wide context org-global)}"

# Same whitespace hazard as release.sh's `tag`: a trailing newline inside the push URL is a bare 403.
GITHUB_TOKEN="$(printf '%s' "$GITHUB_TOKEN" | tr -d '[:space:]')"
REMOTE="https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_SLUG}.git"

# The workflow filter already limits this job to release branches; checked again because deleting the
# wrong branch is the one mistake this script can make.
case "$CIRCLE_BRANCH" in
  release/v*) ;;
  *)
    echo "ERROR: $CIRCLE_BRANCH is not a release branch; refusing to delete it." >&2
    exit 1
    ;;
esac

TAG="v$(node -p "require('./package.json').version")"

# `ls-remote --exit-code` answers 2 for "no such ref" and something else for a failed request, and only
# the first is a clean skip: a network or token failure must not pass for "nothing was released".
rc=0
git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$TAG" >/dev/null || rc=$?
case "$rc" in
  0) git fetch -q "$REMOTE" "+refs/tags/$TAG:refs/tags/$TAG" ;;
  2)
    echo "Keeping $CIRCLE_BRANCH: $TAG does not exist, so this branch released nothing."
    exit 0
    ;;
  *)
    echo "ERROR: could not ask GitHub whether $TAG exists (git exit $rc); keeping $CIRCLE_BRANCH." >&2
    exit 1
    ;;
esac

# A tag cut from some other commit means this push released nothing, and deleting the branch would
# drop commits no tag holds.
if ! git merge-base --is-ancestor "$CIRCLE_SHA1" "$TAG^{commit}"; then
  echo "Keeping $CIRCLE_BRANCH: $CIRCLE_SHA1 is not part of $TAG, so deleting the branch would lose it."
  exit 0
fi

rc=0
git ls-remote --exit-code --heads "$REMOTE" "refs/heads/$CIRCLE_BRANCH" >/dev/null || rc=$?
case "$rc" in
  0)
    git push -q "$REMOTE" --delete "refs/heads/$CIRCLE_BRANCH"
    echo "Deleted $CIRCLE_BRANCH; the release stays reachable from $TAG."
    ;;
  2) echo "$CIRCLE_BRANCH is already gone." ;;
  *)
    echo "ERROR: could not ask GitHub whether $CIRCLE_BRANCH exists (git exit $rc)." >&2
    exit 1
    ;;
esac
