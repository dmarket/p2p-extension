#!/usr/bin/env bash
#
# force-update.sh — raise `web.minExtensionVersion` in the prod config once the store serves a forced release.
#
# Two CircleCI jobs call it (.circleci/config.yml):
#
#   mark   `mark_force_update`, after someone approves `hold_force_update` on a release pipeline. Records the
#          release's numeric version in buckets/prod/force-update.json on `main`. Nothing is published yet:
#          store review takes anywhere from hours to a month, so nothing may wait on it inline.
#
#   poll   `poll_force_update`, from the `force-update-poll` schedule (every 30 min, on `main`). With no marker
#          it exits at once. Otherwise it asks Chrome's update server which version it serves; once that is
#          the marked version or newer, it raises the minimum in the LIVE document (download → raise → upload
#          with ifGenerationMatch on the generation it read), writes that document to
#          buckets/prod/p2p/extension-config.json, deletes the marker and commits both to `main`.
#
# WHY WAIT FOR THE UPDATE SERVER. An install below the minimum calls `runtime.requestUpdateCheck()`, and a check
# that finds nothing throttles the next ones for ~5 h. Raising the minimum only when Chrome already serves the
# build means that one call finds it.
#
# GIT STAYS THE SOURCE OF TRUTH. The live document is patched rather than replaced — whatever was published
# stays — and the result is committed back, so the next `npm run config:upload:prod` from a fresh checkout
# carries the new minimum instead of reverting it. The commit goes straight to `main`: the token belongs to an
# admin (`dmserviceaccount`), which the `main` rulesets let bypass the pull-request rule.
#
# Environment:
#   REPO_SLUG                    owner/repo (the executor sets it)
#   GITHUB_TOKEN                 push to main (context org-global)
#   CIRCLE_BRANCH                mark: the release branch, `release/vX.Y.Z[-label]`
#   GCS_CONFIG_SA_CLIENT_EMAIL,
#   GCS_CONFIG_SA_PRIVATE_KEY    poll: read and overwrite gs://cdn-main-dmarket-com/p2p/extension-config.json
#   SLACK_WEBHOOK_URL            optional: announce the raised minimum
set -euo pipefail
cd "$(dirname "$0")/../.."

MARKER='buckets/prod/force-update.json'
CONFIG='buckets/prod/p2p/extension-config.json'
NODE_SCRIPT='scripts/ci/force-update.mjs'

: "${REPO_SLUG:?REPO_SLUG must be set (the CircleCI executor sets it)}"

remote() {
  : "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (org-wide context org-global)}"
  printf 'https://x-access-token:%s@github.com/%s.git' "$(printf '%s' "$GITHUB_TOKEN" | tr -d '[:space:]')" "$REPO_SLUG"
}

# Succeeds when $1 is an older version than $2. Numeric only; cws-upload.mjs owns the one comparison routine.
older_than() {
  node --input-type=module -e "
    import { compareVersions } from './scripts/ci/cws-upload.mjs';
    process.exit(compareVersions(process.argv[1], process.argv[2]) < 0 ? 0 : 1);
  " "$1" "$2"
}

marked_version() {
  node -e "const v = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).minExtensionVersion;
           if (typeof v !== 'string') process.exit(1); console.log(v);" "$MARKER"
}

commit_and_push() {
  local message="$1"
  shift
  git config user.name "circleci-bot"
  git config user.email "ci@dmarket.com"
  git add -A -- "$@"
  if git diff --cached --quiet; then
    echo "Nothing to commit."
    return 0
  fi
  git commit -q -m "$message"
  # Tolerate a push race with a human commit: replay onto the new tip and try again.
  local attempt
  for attempt in 1 2 3; do
    if git push -q "$(remote)" HEAD:main; then
      echo "Pushed to main: $message"
      return 0
    fi
    echo "Push rejected (attempt $attempt) — rebasing onto the current main." >&2
    git fetch -q "$(remote)" main
    git rebase -q FETCH_HEAD
  done
  echo "ERROR: could not push to main." >&2
  return 1
}

announce() {
  [ -n "${SLACK_WEBHOOK_URL:-}" ] || return 0
  local text="$1"
  curl -fsS -X POST -H 'Content-Type: application/json' \
    --data "$(node -e 'console.log(JSON.stringify({ text: process.argv[1] }))' "$text")" \
    "$SLACK_WEBHOOK_URL" >/dev/null || echo "WARNING: the Slack announcement failed." >&2
}

cmd_mark() {
  : "${CIRCLE_BRANCH:?CIRCLE_BRANCH must be set — this job runs on release branches only}"
  local label version
  label="${CIRCLE_BRANCH#release/v}"
  version="${label%%-*}"
  if ! node --input-type=module -e "
    import { isChromeVersion } from './scripts/ci/force-update.mjs';
    process.exit(isChromeVersion(process.argv[1]) ? 0 : 1);
  " "$version"; then
    echo "ERROR: cannot read a release version from '$CIRCLE_BRANCH'." >&2
    exit 2
  fi

  if [ -f "$MARKER" ]; then
    local pending
    pending="$(marked_version)"
    if ! older_than "$pending" "$version"; then
      echo "A forced update to $pending is already pending; $version does not raise it."
      return 0
    fi
  fi
  node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify(
      { minExtensionVersion: process.argv[2], release: process.argv[3] }, null, 2) + '\n')" \
    "$MARKER" "$version" "$CIRCLE_BRANCH"
  commit_and_push "ci(config): force the update to $version once the store serves it" "$MARKER"
}

cmd_poll() {
  if [ ! -f "$MARKER" ]; then
    echo "No forced update pending."
    return 0
  fi
  local target served
  target="$(marked_version)"
  served="$(node "$NODE_SCRIPT" served)"
  if older_than "$served" "$target"; then
    echo "Waiting: Chrome's update server serves $served, the forced update is to $target."
    return 0
  fi
  echo "Chrome's update server serves $served — raising the minimum to $target."

  # vitest validates the document exactly as buckets/upload.sh does; only this path needs dependencies.
  npm ci --no-audit --no-fund
  local live generation outcome
  live="$(mktemp)"
  generation="$(node "$NODE_SCRIPT" gcs-get "$live")"
  outcome="$(node "$NODE_SCRIPT" raise "$live" "$target")"
  cp "$live" "$CONFIG"
  npx vitest run src/config/bucketConfig.test.ts --reporter=dot
  if [ "$outcome" = raised ]; then
    node "$NODE_SCRIPT" gcs-put "$CONFIG" "$generation"
    echo "Published: web.minExtensionVersion = $target (was generation $generation)."
  else
    echo "The live document already requires $target or newer; nothing to publish."
  fi

  rm -f "$MARKER"
  commit_and_push "config(prod): require extension $target — the store serves $served" "$CONFIG" "$MARKER"
  if [ "$outcome" = raised ]; then
    announce "P2P extension: minExtensionVersion raised to $target (Chrome serves $served). Older installs are asked to update."
  fi
}

case "${1:-}" in
  mark) cmd_mark ;;
  poll) cmd_poll ;;
  *)
    echo "usage: force-update.sh mark|poll" >&2
    exit 2
    ;;
esac
