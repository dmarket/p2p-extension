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
#             served (the watch has finished), hands the version to the raise step that follows in the same job;
#             otherwise halts the job — the watch will read the approval when the store serves the version — but
#             fails instead when no watch waits for it (`watch_store_release` failed, or the watch expired).
#
#   The raise is TWO jobs, so the App key that pushes to `main` never shares a job with dependency code:
#
#   raise     The raise job (`raise_min_version` in the `store_release` pipeline, `approve_force_update` after
#             `approve`). Runs `npm ci` and vitest without secrets, raises the minimum in the LIVE document
#             (download → raise → validate → upload with ifGenerationMatch, one retry on a lost race), and writes
#             force-update/state.json (version, outcome `raised|unchanged`, the release) for the workspace.
#             Touches no git remote and holds no GitHub credential.
#
#   The push job (`push_min_version`, contexts release-writer + dm-release-notify) installs nothing and runs
#   only code from its own clone of `main`; the workspace brings it data, never code:
#
#   load <file>
#             Validates the raise job's state (force-update.mjs `state-read`: plain values only, and about this
#             pipeline's version) and exports it through $BASH_ENV. Halts when there is none — `approve` halted
#             before raising.
#
#   push      Runs inside .circleci/release-writer.sh. Raises the minimum in `main`'s own copy of the document —
#             only that line changes, so a config change merged to `main` but not yet published is never undone —
#             and pushes that one commit straight to `main`, reading `main` again and retrying when another push
#             landed first (3 attempts). Nothing when `main` already requires the version. Exports
#             CONFIG_COMMIT_URL for the notice. The run whose raise changed the live document announces (the upload
#             is pinned to the generation it read, so exactly one of the two paths does); the other halts. When
#             `main` keeps refusing the push, the announcing run exports CONFIG_PUSH_FAILED, lets the notice go out
#             and fails in `finish`; the other run fails at once.
#
#   finish    Fails the job when `push` could not update `main`.
#
#   notice-env <served|expired|raised>
#             The text of a release-channel notice, exported through $BASH_ENV for the `slack/notify` step that
#             follows (.circleci/config.yml `release_notice`) — the same split the backend repos use
#             (`extract_deploy_info` + the circleci/slack orb with a custom Block Kit body, context
#             `dm-release-notify`). Values are JSON-escaped: the orb substitutes them into a JSON body.
#
# A job with nothing to announce HALTS (`circleci-agent step halt`): `approve` while the store does not serve the
# version yet (and a watch still waits for it — otherwise it fails), `load` when nothing was raised, and `push` when
# the other run raised the live document. The halted job is green and its notice step never runs.
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
# GIT CATCHES UP THROUGH A PUSH TO `main`. The live document is patched rather than replaced — whatever was
# published stays — and the same one-line raise goes to `main` as a commit pushed by the `release-writer` GitHub App
# (context `release-writer`, contents: write). `main`'s ruleset "pull request + review + CI" must list that App as
# a bypass actor; without it GitHub refuses the push with a rule violation, the job fails after the notice, and git
# lags behind the live document until someone adds the line by hand. Meanwhile buckets/upload.sh refuses to publish
# a document that would lower the live minimum. The commit changes `main`'s file by that one line only; whatever
# else differs between git and the live document is left to whoever publishes it.
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
#   STORE_SERVED_VERSION    raise / push: what the update server served when the watch fired
#   P2P_EXTENSION_DEPLOY_SA_KEY
#                           raise: the service-account key for the one bucket object (see scripts/ci/force-update.mjs)
#   RELEASE_TOKEN           push: set by .circleci/release-writer.sh (context release-writer), which also
#                           supplies it to git as the credential for this repository
#   RAISE_OUTCOME,
#   CONFIG_COMMIT_URL,
#   CONFIG_PUSH_FAILED      push / finish / notice-env: what `load` and the previous steps exported
#   FORCE_UPDATE            notice-env: `true` when the release was forced (the `store_release` pipeline parameter)
#   BASH_ENV                notice-env: where the notice is exported (CircleCI sets it)
set -euo pipefail
cd "$(dirname "$0")/../.."

# Dependency code (npm ci's install scripts, vitest) runs without the credentials this job holds: every project
# variable and the job's contexts reach it, including the bucket key. Same limit as `drop_store_secrets` in the
# CircleCI config: it clears the child's environment, not the container's, and what the child writes to disk or to
# $BASH_ENV still reaches the job's later steps. That is why the job that runs it holds no GitHub credential and
# hands the push job data only (`load`).
without_secrets() {
  env -u P2P_EXTENSION_DEPLOY_SA_KEY -u GITHUB_TOKEN -u CIRCLE_API_TOKEN -u SLACK_ACCESS_TOKEN \
    -u RELEASE_WRITER_PRIVATE_KEY -u RELEASE_TOKEN -u GH_TOKEN \
    -u CRX_SIGNING_KEY_B64 -u CHROME_SERVICE_ACCOUNT_PRIVATE_KEY -u CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL "$@"
}

CONFIG='buckets/prod/p2p/extension-config.json'
NODE_SCRIPT='scripts/ci/force-update.mjs'
STATE='force-update/state.json'

: "${REPO_SLUG:?REPO_SLUG must be set (the CircleCI executor sets it)}"

# Hand a value to the job's later steps: CircleCI sources $BASH_ENV at the start of every step.
export_env() {
  : "${BASH_ENV:?BASH_ENV must be set (CircleCI sets it)}"
  printf 'export %s=%q\n' "$1" "$2" >> "$BASH_ENV"
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
    # Leaving it to the watch is only safe while one waits: if `watch_store_release` failed or the watch expired,
    # nothing would ever read this approval.
    if [ "$(node "$NODE_SCRIPT" watching "$RELEASE_VERSION")" != yes ]; then
      echo "ERROR: Chrome's update server serves $served, and no store-release schedule watches $RELEASE_VERSION," >&2
      echo "so nothing would raise the minimum later. Re-run this job once the store serves $RELEASE_VERSION," >&2
      echo "or re-run watch_store_release first." >&2
      exit 1
    fi
    halt_job "Chrome's update server serves $served; the watch raises the minimum to $RELEASE_VERSION once it serves the release."
    return 0
  fi
  echo "Chrome's update server serves $served: raising the minimum to $RELEASE_VERSION now."
  export_env STORE_WATCH_VERSION "$RELEASE_VERSION"
  export_env STORE_SERVED_VERSION "$served"
  export_env RELEASE_LABEL "$RELEASE_LABEL"
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
      if [ "${CONFIG_PUSH_FAILED:-}" = 1 ]; then
        quote="$quote main was not updated: set it in buckets/prod/p2p/extension-config.json by hand."
      elif [ -n "${CONFIG_COMMIT_URL:-}" ]; then
        quote="$quote <${CONFIG_COMMIT_URL}|Committed to main>."
      fi
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
  local target="$STORE_WATCH_VERSION"
  require_version "$target" "the forced version"

  # vitest validates the document exactly as buckets/upload.sh does; only this path needs dependencies.
  without_secrets npm ci --no-audit --no-fund
  local live generation outcome attempt rc
  live="$(mktemp)"
  for attempt in 1 2; do
    generation="$(node "$NODE_SCRIPT" gcs-get "$live")"
    outcome="$(node "$NODE_SCRIPT" raise "$live" "$target")"
    cp "$live" "$CONFIG"
    without_secrets npx vitest run src/config/bucketConfig.test.ts --reporter=dot
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

  # Already raised (by the other path, or a re-run): nothing new to publish, but git may still lag behind, so the
  # push job runs either way; its `push` step decides whether there is anything to announce.
  [ "$outcome" = raised ] || echo "The live document already requires $target or newer; nothing to publish."
  mkdir -p "$(dirname "$STATE")"
  node "$NODE_SCRIPT" state-write "$STATE" "$outcome"
  echo "Handed on: $(cat "$STATE")"
}

cmd_load() {
  local file="${1:?usage: force-update.sh load <state.json>}" lines name value expected="${PIPELINE_WATCH_VERSION:-}"
  if [ ! -f "$file" ]; then
    halt_job "No raise state in the workspace: the minimum was not raised in this pipeline."
    return 0
  fi
  # The version this pipeline is about: the store watch's parameter, or the release branch's name.
  if [ -z "$expected" ] && [[ "${CIRCLE_BRANCH:-}" == release/v* ]]; then
    expected="${CIRCLE_BRANCH#release/v}"
    expected="${expected%%-*}"
  fi
  lines="$(node "$NODE_SCRIPT" state-read "$file" ${expected:+"$expected"})"
  while IFS='=' read -r name value; do
    export_env "$name" "$value"
  done <<< "$lines"
  echo "Loaded: $lines" | tr '\n' ' '
  echo
}

cmd_push() {
  : "${STORE_WATCH_VERSION:?STORE_WATCH_VERSION must be set (force-update.sh load)}"
  local target="$STORE_WATCH_VERSION" served="${STORE_SERVED_VERSION:-}" proposed tree attempt result=failed sha
  require_version "$target" "the forced version"
  proposed="$(mktemp)"
  for attempt in 1 2 3; do
    git fetch -q origin main
    # main's own copy with only the minimum raised: a change merged to main but not yet published stays as it is.
    git show "FETCH_HEAD:$CONFIG" > "$proposed"
    if [ "$(node "$NODE_SCRIPT" raise "$proposed" "$target")" = unchanged ]; then
      echo "main already requires $target or newer; nothing to push."
      result=unchanged
      break
    fi
    # A separate worktree, so the clone this script runs from never changes under it.
    tree="$(mktemp -d)"
    git worktree add -q --detach "$tree" FETCH_HEAD
    cp "$proposed" "$tree/$CONFIG"
    git -C "$tree" add -- "$CONFIG"
    git -C "$tree" -c user.name=circleci-bot -c user.email=ci@dmarket.com \
      commit -q -m "config(prod): require extension $target — the store serves ${served:-it}"
    if git -C "$tree" push -q origin HEAD:refs/heads/main; then
      sha="$(git -C "$tree" rev-parse HEAD)"
      result=pushed
    fi
    git worktree remove --force "$tree"
    if [ "$result" = pushed ]; then
      echo "Pushed $sha to main."
      export_env CONFIG_COMMIT_URL "https://github.com/${REPO_SLUG}/commit/$sha"
      break
    fi
    # Usually another commit landed on main first (the other raise path, or anyone): read main again.
    echo "main refused the push (attempt $attempt)." >&2
  done
  if [ "$result" = failed ]; then
    echo "ERROR: could not push the raised minimum to main. A rule violation above means the release-writer" >&2
    echo "App is not a bypass actor on main's ruleset; set web.minExtensionVersion to $target in $CONFIG by hand." >&2
    if [ "${RAISE_OUTCOME:-}" = raised ]; then
      export_env CONFIG_PUSH_FAILED 1 # announce the raise first; `finish` fails the job after the notice
      return 0
    fi
    exit 1
  fi
  [ "${RAISE_OUTCOME:-}" = raised ] || halt_job "Nothing to announce: the other run raised the live document."
}

cmd_finish() {
  if [ "${CONFIG_PUSH_FAILED:-}" = 1 ]; then
    echo "ERROR: the minimum is raised in the live document, but main was not updated." >&2
    exit 1
  fi
  echo "Done."
}

case "${1:-}" in
  watch) cmd_watch ;;
  poll) cmd_poll ;;
  approve) cmd_approve ;;
  raise) cmd_raise ;;
  load) shift; cmd_load "$@" ;;
  push) cmd_push ;;
  finish) cmd_finish ;;
  notice-env) shift; cmd_notice_env "$@" ;;
  *)
    echo "usage: force-update.sh watch|poll|approve|raise|load <state.json>|push|finish|notice-env <served|expired|raised>" >&2
    exit 2
    ;;
esac
