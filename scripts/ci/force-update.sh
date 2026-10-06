#!/usr/bin/env bash
#
# force-update.sh — watch for a released version in the Chrome Web Store, announce it, and raise
# `web.minExtensionVersion` in the prod config when the release was approved as a forced update.
#
# THE RULE: the minimum is raised once the version is SERVED and `hold_force_update` is APPROVED — by whichever of
# the two happens second. Both paths are idempotent (the minimum is never lowered, the upload is pinned to the
# generation it read, an unchanged document commits nothing), so meeting in the middle is harmless.
#
# Subcommands, one per CircleCI job (.circleci/config.yml):
#
#   watch     `watch_store_release`, right after `upload_to_store` on EVERY release. Creates a CircleCI schedule,
#             `store-release-<version>`, that runs `poll` every 30 minutes on `main` with the version, a deadline
#             and this release's workflow id as pipeline parameters. Store review takes anywhere from hours to a
#             month, so nothing may wait on it inline.
#
#   poll      `poll_store_release`, run by that schedule. Asks Chrome's update server what it serves; once that is
#             the release or newer, reads whether `hold_force_update` was approved in the release pipeline and
#             starts one `store_release` pipeline (the Slack notice and, when forced, the raise, in parallel), then
#             deletes its own schedule. A schedule still waiting at its deadline starts the pipeline with
#             outcome `expired`, deletes itself and fails.
#
#   approve   `approve_force_update`, after someone approves `hold_force_update`. When the version is already
#             served (the watch has finished), raises the minimum right away; otherwise does nothing — the watch
#             will read the approval when the store serves the version.
#
#   raise     `raise_min_version` in the `store_release` pipeline, and `approve` above. Raises the minimum in the
#             LIVE document (download → raise → validate → upload with ifGenerationMatch, one retry on a lost
#             race) and commits it to buckets/prod/p2p/extension-config.json on `main`.
#
#   notice-env <served|expired|raised>
#             The text of a release-channel notice, exported through $BASH_ENV for the `slack/notify` step that
#             follows (.circleci/config.yml `release_notice`) — the same split the backend repos use
#             (`extract_deploy_info` + the circleci/slack orb with a custom Block Kit body, context
#             `dm-release-notify`). Values are JSON-escaped: the orb substitutes them into a JSON body.
#
# A job with nothing to announce HALTS (`circleci-agent step halt`): `approve` while the store does not serve the
# version yet, and `raise` when the document already required it. The halted job is green and its notice step
# never runs, so the channel hears about each raise exactly once.
#
# THE APPROVAL LIVES IN THE RELEASE PIPELINE. The deferred pipelines never decide whether a release is forced;
# they read the approval job's state through the API.
#
# NOTHING RUNS BETWEEN RELEASES. The schedule is the pending state and lives exactly as long as the wait.
#
# WHY WAIT FOR THE UPDATE SERVER. An install below the minimum calls `runtime.requestUpdateCheck()`, and a check
# that finds nothing throttles the next ones for ~5 h. Raising the minimum only when Chrome already serves the
# build means that one call finds it. It is also the moment users actually get the release, which is what the
# Slack notice announces — not the dashboard's "approved".
#
# GIT STAYS THE SOURCE OF TRUTH. The live document is patched rather than replaced — whatever was published
# stays — and the result is committed back, so the next `npm run config:upload:prod` from a fresh checkout
# carries the new minimum instead of reverting it. The commit goes straight to `main`: the token belongs to an
# admin (`dmserviceaccount`), which the `main` rulesets let bypass the pull-request rule.
#
# Environment:
#   REPO_SLUG               owner/repo (the executor sets it)
#   CIRCLE_API_TOKEN        watch / poll: CircleCI personal API token (schedule, approval state, trigger)
#   CIRCLE_BRANCH,
#   CIRCLE_SHA1,
#   CIRCLE_WORKFLOW_ID,
#   CIRCLE_USERNAME         watch / approve: the release pipeline (CircleCI sets them)
#   STORE_WATCH_VERSION,
#   STORE_WATCH_UNTIL,
#   SCHEDULE_ID,
#   RELEASE_WORKFLOW_ID,
#   RELEASE_LABEL,
#   RELEASE_SHA,
#   RELEASE_ACTOR           poll: the schedule's pipeline parameters and its own id (the job sets them)
#   STORE_SERVED_VERSION    raise: what the update server served when the watch fired
#   GITHUB_TOKEN            raise: push to main (context org-global)
#   P2P_EXTENSION_DEPLOY_SA_KEY
#                           raise: the service-account key for the one bucket object (see scripts/ci/force-update.mjs)
#   FORCE_UPDATE            notice-env: `true` when the release was forced (the `store_release` pipeline parameter)
#   BASH_ENV                notice-env: where the notice is exported (CircleCI sets it)
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

# The release this pipeline builds, from its branch: `release/v1.0.7-beta` → label `1.0.7-beta`, version `1.0.7`.
release_from_branch() {
  : "${CIRCLE_BRANCH:?CIRCLE_BRANCH must be set — this job runs on release branches only}"
  RELEASE_LABEL="${CIRCLE_BRANCH#release/v}"
  RELEASE_VERSION="${RELEASE_LABEL%%-*}"
  require_version "$RELEASE_VERSION" "from branch $CIRCLE_BRANCH"
}

cmd_watch() {
  release_from_branch
  : "${CIRCLE_WORKFLOW_ID:?CIRCLE_WORKFLOW_ID must be set (CircleCI sets it)}"
  RELEASE_WORKFLOW_ID="$CIRCLE_WORKFLOW_ID" RELEASE_LABEL="$RELEASE_LABEL" RELEASE_SHA="${CIRCLE_SHA1:-}" \
    RELEASE_ACTOR="${CIRCLE_USERNAME:-}" node "$NODE_SCRIPT" schedule "$RELEASE_VERSION"
}

cmd_poll() {
  : "${STORE_WATCH_VERSION:?STORE_WATCH_VERSION must be set — this job runs from a store-release schedule}"
  : "${SCHEDULE_ID:?SCHEDULE_ID must be set — this job runs from a store-release schedule}"
  : "${RELEASE_WORKFLOW_ID:?RELEASE_WORKFLOW_ID must be set — this job runs from a store-release schedule}"
  local target="$STORE_WATCH_VERSION" served force
  require_version "$target" "pipeline parameter store_watch_version"

  served="$(node "$NODE_SCRIPT" served)"
  if older_than "$served" "$target"; then
    # Checked only while unserved: a version served on its deadline day is a release, not an expiry.
    if [ -n "${STORE_WATCH_UNTIL:-}" ] && [[ "$(date -u +%F)" > "$STORE_WATCH_UNTIL" ]]; then
      node "$NODE_SCRIPT" trigger expired no "$served"
      node "$NODE_SCRIPT" unschedule "$SCHEDULE_ID"
      echo "ERROR: $target was not served by $STORE_WATCH_UNTIL; the schedule is deleted, the minimum unchanged." >&2
      exit 1
    fi
    echo "Waiting: Chrome's update server serves $served, the release is $target."
    return 0
  fi

  force="$(node "$NODE_SCRIPT" approved "$RELEASE_WORKFLOW_ID")"
  echo "Chrome's update server serves $served (release $target, forced: $force)."
  # Trigger first, unschedule last: a failed delete repeats the notice on the next run, while the reverse order
  # could lose both the notice and the raise.
  node "$NODE_SCRIPT" trigger served "$force" "$served"
  node "$NODE_SCRIPT" unschedule "$SCHEDULE_ID"
}

cmd_approve() {
  release_from_branch
  local served
  served="$(node "$NODE_SCRIPT" served)"
  if older_than "$served" "$RELEASE_VERSION"; then
    halt_job "Chrome's update server serves $served; the watch raises the minimum to $RELEASE_VERSION once it serves the release."
    return 0
  fi
  export STORE_WATCH_VERSION="$RELEASE_VERSION" STORE_SERVED_VERSION="$served" RELEASE_LABEL
  cmd_raise
}

# End the job here, green, skipping its remaining steps — i.e. its release notice. Outside CircleCI it only logs.
halt_job() {
  echo "$1"
  if command -v circleci-agent >/dev/null 2>&1; then circleci-agent step halt; fi
}

# A JSON string body (no quotes), for a value the orb substitutes into its JSON payload.
json_text() {
  node -e 'process.stdout.write(JSON.stringify(process.argv[1]).slice(1, -1))' "$1"
}

cmd_notice_env() {
  local kind="${1:?usage: force-update.sh notice-env served|expired|raised}"
  : "${BASH_ENV:?BASH_ENV must be set (CircleCI sets it)}"
  local label="${RELEASE_LABEL:-}" sha="${RELEASE_SHA:-${CIRCLE_SHA1:-}}" actor="${RELEASE_ACTOR:-${CIRCLE_USERNAME:-}}"
  [ -n "$label" ] || label="${CIRCLE_BRANCH#release/v}"
  local target="${STORE_WATCH_VERSION:-${label%%-*}}"
  local subject="Release v$label" author='' short='' commit_url=''
  # The release commit is on `main` (the release branch is cut from it and never diverges), so git knows it.
  if [ -n "$sha" ] && git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    subject="$(git log -1 --format=%s "$sha")"
    author="$(git log -1 --format=%an "$sha")"
  fi
  if [ -n "$sha" ]; then
    short="${sha:0:7}"
    commit_url="https://github.com/${REPO_SLUG}/commit/${sha}"
  fi
  local release="<https://github.com/${REPO_SLUG}/releases/tag/v${label}|${label}>"
  local headline quote version
  case "$kind" in
    served)
      headline=':rocket: *p2p-extension* released to *Chrome Web Store*'
      [ "${FORCE_UPDATE:-}" = true ] && headline="$headline (forced update)"
      quote="$subject"
      version="$release (served ${STORE_SERVED_VERSION:-?})"
      ;;
    expired)
      headline=':warning: *Chrome Web Store* never served *p2p-extension*'
      quote="Not served by ${STORE_WATCH_UNTIL:-the deadline}: the watch gave up, minExtensionVersion is unchanged."
      version="$release"
      ;;
    raised)
      headline=':warning: *Forced update* applied for *p2p-extension*'
      quote="web.minExtensionVersion is now $target: older installs are asked to update."
      version="$release"
      ;;
    *)
      echo "usage: force-update.sh notice-env served|expired|raised" >&2
      exit 2
      ;;
  esac
  {
    printf 'export NOTICE_HEADLINE=%q\n' "$(json_text "$headline")"
    printf 'export NOTICE_QUOTE=%q\n' "$(json_text "$quote")"
    printf 'export NOTICE_AUTHOR=%q\n' "$(json_text "${author:-n/a}")"
    printf 'export NOTICE_TRIGGERED_BY=%q\n' "$(json_text "${actor:-n/a}")"
    printf 'export NOTICE_VERSION=%q\n' "$(json_text "$version")"
    printf 'export NOTICE_COMMIT=%q\n' "$(json_text "${commit_url:+<$commit_url|$short>}")"
  } >> "$BASH_ENV"
  echo "Notice ($kind): $headline — $quote"
}

cmd_raise() {
  : "${STORE_WATCH_VERSION:?STORE_WATCH_VERSION must be set}"
  local target="$STORE_WATCH_VERSION" served="${STORE_SERVED_VERSION:-}"
  require_version "$target" "the forced version"

  # vitest validates the document exactly as buckets/upload.sh does; only this path needs dependencies.
  npm ci --no-audit --no-fund
  local live generation outcome attempt rc
  live="$(mktemp)"
  for attempt in 1 2; do
    generation="$(node "$NODE_SCRIPT" gcs-get "$live")"
    outcome="$(node "$NODE_SCRIPT" raise "$live" "$target")"
    cp "$live" "$CONFIG"
    npx vitest run src/config/bucketConfig.test.ts --reporter=dot
    if [ "$outcome" != raised ]; then
      break
    fi
    rc=0
    node "$NODE_SCRIPT" gcs-put "$CONFIG" "$generation" || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "Published: web.minExtensionVersion = $target (was generation $generation)."
      break
    fi
    # 3 = the object moved since it was read — typically the other path raising at the same moment. Re-read once.
    if [ "$rc" -ne 3 ] || [ "$attempt" -eq 2 ]; then exit "$rc"; fi
    echo "The live document changed while this run held it (attempt $attempt); reading it again." >&2
  done

  commit_and_push "config(prod): require extension $target — the store serves ${served:-it}" "$CONFIG"
  # Already raised (by the other path, or a re-run): nothing new to announce.
  [ "$outcome" = raised ] || halt_job "The live document already requires $target or newer; nothing to publish."
}

case "${1:-}" in
  watch) cmd_watch ;;
  poll) cmd_poll ;;
  approve) cmd_approve ;;
  raise) cmd_raise ;;
  notice-env) shift; cmd_notice_env "$@" ;;
  *)
    echo "usage: force-update.sh watch|poll|approve|raise|notice-env <served|expired|raised>" >&2
    exit 2
    ;;
esac
