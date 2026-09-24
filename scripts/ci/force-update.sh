#!/usr/bin/env bash
#
# force-update.sh — raise `web.minExtensionVersion` in the prod config once the store serves a forced release.
#
# Two CircleCI jobs call it (.circleci/config.yml):
#
#   mark   `mark_force_update`, after someone approves `hold_force_update` on a release pipeline. Creates a
#          CircleCI schedule, `force-update-<version>`, that runs the poll every 30 minutes on `main` with
#          the version as a pipeline parameter. Nothing is published yet: store review takes anywhere from
#          hours to a month, so nothing may wait on it inline.
#
#   poll   `poll_force_update`, run by that schedule. Asks Chrome's update server which version it serves;
#          once that is the forced version or newer, it raises the minimum in the LIVE document (download →
#          raise → upload with ifGenerationMatch on the generation it read), commits that document to
#          buckets/prod/p2p/extension-config.json on `main`, and deletes its own schedule. A schedule still
#          waiting after 45 days deletes itself and fails loudly: the release never reached users.
#
# NOTHING RUNS BETWEEN FORCED RELEASES. The schedule is the pending state and lives exactly as long as the
# wait; there is no standing poller.
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
#   REPO_SLUG             owner/repo (the executor sets it)
#   CIRCLE_API_TOKEN      CircleCI personal API token: create (mark) and delete (poll) the schedule
#   CIRCLE_BRANCH         mark: the release branch, `release/vX.Y.Z[-label]`
#   FORCE_UPDATE_VERSION,
#   FORCE_UPDATE_UNTIL,
#   SCHEDULE_ID           poll: the schedule's pipeline parameters and its own id (the job sets them)
#   GITHUB_TOKEN          poll: push to main (context org-global)
#   GCP_WIF_AUDIENCE,
#   CIRCLE_OIDC_TOKEN_V2  poll: Cloud Storage access without a stored key (see scripts/ci/force-update.mjs)
#   SLACK_WEBHOOK_URL     optional: announce the raised minimum, or a release that never arrived
set -euo pipefail
cd "$(dirname "$0")/../.."

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

require_version() {
  if ! node --input-type=module -e "
    import { isChromeVersion } from './scripts/ci/force-update.mjs';
    process.exit(isChromeVersion(process.argv[1]) ? 0 : 1);
  " "$1"; then
    echo "ERROR: '$1' is not a numeric extension version ($2)." >&2
    exit 2
  fi
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
  require_version "$version" "from branch $CIRCLE_BRANCH"
  node "$NODE_SCRIPT" schedule "$version"
}

cmd_poll() {
  : "${FORCE_UPDATE_VERSION:?FORCE_UPDATE_VERSION must be set — this job runs from a force-update schedule}"
  : "${SCHEDULE_ID:?SCHEDULE_ID must be set — this job runs from a force-update schedule}"
  local target="$FORCE_UPDATE_VERSION" served
  require_version "$target" "pipeline parameter force_update_version"

  if [ -n "${FORCE_UPDATE_UNTIL:-}" ] && [[ "$(date -u +%F)" > "$FORCE_UPDATE_UNTIL" ]]; then
    node "$NODE_SCRIPT" unschedule "$SCHEDULE_ID"
    announce "P2P extension: gave up waiting for $target — Chrome's update server did not serve it by $FORCE_UPDATE_UNTIL. minExtensionVersion is unchanged."
    echo "ERROR: $target was not served by $FORCE_UPDATE_UNTIL; the schedule is deleted, the minimum unchanged." >&2
    exit 1
  fi

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

  commit_and_push "config(prod): require extension $target — the store serves $served" "$CONFIG"
  # Last, so any failure above leaves the schedule in place and the next run finishes the job. Every step is
  # idempotent: an already-raised document publishes nothing and commits nothing new.
  node "$NODE_SCRIPT" unschedule "$SCHEDULE_ID"
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
