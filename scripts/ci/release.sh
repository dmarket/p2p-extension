#!/usr/bin/env bash
#
# release.sh <resolve|guard|tag|publish> — the four steps of the CircleCI `release` job.
#
# Called as `bash scripts/ci/release.sh <step>` from .circleci/config.yml, one CircleCI step per
# subcommand so each shows up separately in the UI. The logic lives here rather than inline in the
# YAML for three reasons: CircleCI caps a single config expression at 2048 characters (this job's
# publish step was 3951 and the config was rejected outright); a YAML block scalar re-indents
# heredocs and hides quoting bugs that only surface at run time; and a real file can be executed
# and reviewed as shell — `bash scripts/ci/release.sh guard` runs standalone.
#
# CONTRACT: every step exits 0 when there is simply nothing to release, and non-zero only for a
# real mistake. `resolve` decides which case this is and exports RELEASE=true|false through
# $BASH_ENV; the other three no-op when it is false.
#
# Environment:
#   REPO_SLUG      owner/repo (set by the executor in .circleci/config.yml)
#   GITHUB_TOKEN   contents:write — needed by `tag` and `publish` only
#   BASH_ENV       CircleCI's per-job env file, sourced before every step
set -euo pipefail

CMD="${1:-}"
: "${REPO_SLUG:?REPO_SLUG must be set (the CircleCI executor sets it)}"
: "${BASH_ENV:=/tmp/bash_env}"

API="https://api.github.com/repos/${REPO_SLUG}"

# True when `resolve` decided this push is a release. Anything else is a clean no-op.
releasing() { [ "${RELEASE:-false}" = "true" ]; }
skip() { echo "Not releasing — skipped."; }

# The tracker-core version this build resolved, read from package-lock.json — the same source
# wxt.config.ts's buildId() reads, and the only one available here (this job installs nothing, so
# there is no node_modules). Empty if it cannot be determined.
core_version() {
  node -e '
    const lock = require("./package-lock.json");
    process.stdout.write(lock.packages?.["node_modules/@dmarket/p2p-tracker-core"]?.version ?? "");'
}

# ── resolve ───────────────────────────────────────────────────────────────────────────────────────
resolve() {
  local version tag release messages
  version="$(node -p "require('./package.json').version")"
  tag="v$version"
  release=true

  # --- Opt-out: "[skip release]" in the commit message. A true merge commit's own message is
  # boilerplate ("Merge pull request #12 ..."), so the flag lives on the commits merged in.
  messages="$(git log -1 --pretty=%B HEAD)"
  if git rev-parse --verify -q 'HEAD^2' >/dev/null 2>&1; then
    messages="$messages
$(git log --pretty=%B 'HEAD^1..HEAD^2')"
  fi
  if printf '%s' "$messages" |
    grep -Eiq '\[[[:space:]]*(skip[[:space:]_-]*release|release[[:space:]_-]*skip)[[:space:]]*\]'; then
    echo "Skipping: commit message contains [skip release]."
    release=false
  fi

  # --- Idempotency / "the version was not bumped": ask the remote, not the local ref store, so a
  # lost race with a parallel pipeline is also caught.
  if [ "$release" = "true" ] && git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    echo "Nothing to release: $tag already exists. Bump \"version\" in package.json to cut a release."
    release=false
  fi

  # --- A snapshot core is not releasable, at any version. `package.json` depends on the `snapshot`
  # DIST-TAG, so a `-SNAPSHOT.<n>` core is the default state of this repository — and a snapshot can be
  # unpublished from npm, which makes the build unreproducible. This is the extension's equivalent of
  # the core repo's own rule (a `-SNAPSHOT` version publishes, but is never tagged and gets no GitHub
  # Release), expressed on the only axis a Chrome manifest version leaves available: not the version
  # string, which must be 1-4 integers, but what the build was made from.
  #
  # A clean SKIP, not a failure, and that distinction is load-bearing: the tag is never created, so the
  # idempotency check above can never start skipping on its own, and a hard failure here would leave
  # main permanently red for every push until the core pin moves.
  if [ "$release" = "true" ]; then
    case "$(core_version)" in
      *-SNAPSHOT*)
        echo "Nothing to release: built against a snapshot core ($(core_version))."
        echo "Releases come from a stable core — bump \"@dmarket/p2p-tracker-core\" in package.json,"
        echo "run npm install, and commit the lockfile."
        release=false
        ;;
    esac
  fi

  {
    echo "export VERSION='$version'"
    echo "export TAG='$tag'"
    echo "export RELEASE='$release'"
  } >> "$BASH_ENV"
  echo "version=$version tag=$tag release=$release"
}

# ── guard ─────────────────────────────────────────────────────────────────────────────────────────
guard() {
  releasing || { skip; return 0; }

  # A release without notes is a release nobody can read later.
  if ! grep -qE "^## \[$VERSION\]" CHANGELOG.md; then
    echo "ERROR: CHANGELOG.md has no '## [$VERSION]' section for this release." >&2
    return 1
  fi

  # --require-derived-hosts is the irreversible-mistake guard: the collector and Firebase host
  # permissions are derived from build-time variables, and a host permission ADDED in a later update
  # disables the extension for every existing user until they re-consent. They must be in the first
  # published build, so a build that missed its context must never reach a tag.
  node scripts/verify-build.mjs artifacts/manifest.chrome.json --mode production --require-derived-hosts

  # --- The core must be identifiable. A snapshot core has already been skipped in `resolve`; reaching
  # here with no readable version at all is a different thing — a broken checkout or lockfile — and a
  # release whose core cannot be named is one nobody can reproduce or map a crash report to. Fail.
  local core
  core="$(core_version)"
  if [ -z "$core" ]; then
    echo "ERROR: cannot read the core version from package-lock.json — refusing to tag a build whose" >&2
    echo "       core cannot be identified." >&2
    return 1
  fi
  echo "Releasing $VERSION against core $core."
}

# ── tag ───────────────────────────────────────────────────────────────────────────────────────────

# Turn a bare `403` from git into a cause. GitHub answers 401 for a token it does not recognise and
# 403 for one it recognises but will not let through, so a 403 on the push is always an authorisation
# question — never "the variable is missing" (the `:?` above already covers that) and, here, never tag
# protection either (this repository has no rulesets). Only runs when the push has already failed.
diagnose_push_denied() {
  local code perms
  code="$(curl -sS -o /tmp/repo-probe.json -w '%{http_code}' -H "$AUTH" "$API" || echo 000)"
  echo "       diagnosis — GET $API answered HTTP $code:" >&2
  case "$code" in
    200)
      perms="$(node -e '
        const r = require("/tmp/repo-probe.json");
        process.stdout.write(JSON.stringify(r.permissions ?? {}));' 2>/dev/null || echo '{}')"
      echo "       the token CAN read this repository; its permissions are $perms." >&2
      echo "       \"push\": false means it lacks Contents: write — the one permission a tag needs." >&2
      ;;
    401) echo "       the token was not recognised at all: wrong value, or expired." >&2 ;;
    403)
      echo "       the API refuses it too. Typical causes: a fine-grained token whose organization" >&2
      echo "       approval is still pending (dmarket -> Settings -> Personal access tokens), or SSO" >&2
      echo "       not authorised for this token." >&2
      ;;
    404)
      echo "       the token cannot even see this repository. A fine-grained token needs Resource" >&2
      echo "       owner = dmarket AND p2p-extension in its repository selection." >&2
      ;;
    *) echo "       could not reach the API to say more." >&2 ;;
  esac
}

tag() {
  releasing || { skip; return 0; }
  : "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (org-wide context org-global)}"

  # A value pasted into a CI form can arrive with a trailing newline, which lands inside the push URL
  # and is rejected as a bad credential — a 403 with no hint. Tokens never contain whitespace, so
  # trimming is safe; it is announced rather than silent so the stored value gets fixed.
  local trimmed
  trimmed="$(printf '%s' "$GITHUB_TOKEN" | tr -d '[:space:]')"
  if [ "$trimmed" != "$GITHUB_TOKEN" ]; then
    echo "WARNING: GITHUB_TOKEN had surrounding whitespace — trimming it for this run, but fix the" >&2
    echo "         value stored in the org-global context." >&2
    GITHUB_TOKEN="$trimmed"
    AUTH="Authorization: Bearer ${GITHUB_TOKEN}"
  fi

  git config user.name "circleci-bot"
  git config user.email "ci@dmarket.com"
  # Creating the tag is idempotent so a re-run of this job (or an SSH rerun, where the working
  # directory survives) fails on the push guard below rather than on `tag: already exists`, which
  # says nothing about whether the remote has it.
  if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    git tag -a "$TAG" -m "Release $TAG"
  fi
  # Tolerate losing a race to a parallel pipeline: the tag existing is the desired end state.
  if ! git push "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO_SLUG}.git" "$TAG"; then
    if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
      echo "$TAG already on the remote — another pipeline won the race."
    else
      echo "ERROR: pushing $TAG failed." >&2
      diagnose_push_denied
      return 1
    fi
  fi
  echo "Tagged $TAG."
}

# ── publish ───────────────────────────────────────────────────────────────────────────────────────

# The release notes: this version's CHANGELOG section, plus how to install the attachments.
write_notes() {
  awk "/^## \[$VERSION\]/{f=1;next} /^## \[/{f=0} /^\[[^]]*\]:/{f=0} f" CHANGELOG.md > /tmp/notes.md
  cat >> /tmp/notes.md <<'NOTES'

---

### Manual install (Chrome)

1. Download `dmarket-p2p-extension-<version>-chrome.zip` below and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. **Load unpacked** → select the unzipped folder.

This is the **production** build — the same artifact that goes to the store. The debug build (debug
console, internal endpoints) is deliberately not published here; it lives in the `build-debug` job's
Artifacts tab in CircleCI. The `-sourcemaps.tar.gz` archive is for symbolicating crash reports; it is
not needed to run the extension. `SHA256SUMS` covers every attachment.
NOTES
  # Provenance, in the exact shape wxt.config.ts compiles into the bundle as `__BUILD_ID__` — which is
  # what a crash report carries as `appVersion`. Printing it here is what lets a report be traced back
  # to a release, and it puts the resolved core version (a `-SNAPSHOT.<n>` on any 0.x prerelease) on the
  # record rather than only inside the zip. printf, not echo: the backticks must stay literal.
  printf '\n### Build\n\n`%s+core%s`\n\nThe same string this build reports as `appVersion` in a crash report.\n' \
    "$(git rev-parse --short HEAD)" "$(core_version)" >> /tmp/notes.md
}

# Create the release, or adopt an existing one for this tag (re-run safe). Echoes its id.
resolve_release_id() {
  local id
  id="$(curl -sS -H "$AUTH" "$API/releases/tags/$TAG" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let id = ""; try { id = JSON.parse(s).id ?? ""; } catch {}
      process.stdout.write(String(id));
    });')"
  if [ -n "$id" ]; then
    echo "Release for $TAG already exists (id $id) — reusing it." >&2
    printf '%s' "$id"
    return 0
  fi
  # Marked "Pre-release" on GitHub for anything that is not a finished version: a 0.x, or any SemVer
  # prerelease suffix (`1.0.0-beta.1`). The suffix half matters — without it the first beta would be
  # presented as the project's Latest release, which is what people download by default.
  node -e '
    const fs = require("fs");
    const v = process.env.VERSION;
    process.stdout.write(JSON.stringify({
      tag_name: process.env.TAG,
      name: process.env.TAG,
      body: fs.readFileSync("/tmp/notes.md", "utf8"),
      draft: false,
      prerelease: v.startsWith("0.") || v.includes("-"),
    }));' > /tmp/release.json
  id="$(curl -sSf -X POST -H "$AUTH" -H "Accept: application/vnd.github+json" \
    "$API/releases" -d @/tmp/release.json | node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        process.stdout.write(String(JSON.parse(s).id));
      });')"
  echo "Created release $TAG (id $id)." >&2
  printf '%s' "$id"
}

publish() {
  releasing || { skip; return 0; }
  : "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (org-wide context org-global)}"

  # ONLY the production build is published. The debug bundle stays in the `build-debug` job's Artifacts
  # tab: it is not what ships, and it inlines the internal WXT_DEV_* hostnames that were deliberately
  # scrubbed from the sources before this repository goes public. Keeping it out of the Release is also
  # what lets `release` start without waiting for `build-debug` — otherwise the asset set would depend
  # on which job happened to finish first.
  #
  # Named explicitly rather than globbing artifacts/*: the asset set is then the same on every release,
  # and a file that appears in the workspace for any other reason cannot be published by accident.
  local prod="dmarket-p2p-extension-${VERSION}-chrome.zip"
  local maps="dmarket-p2p-extension-${VERSION}-chrome-sourcemaps.tar.gz"
  local assets="$prod $maps manifest.chrome.json"

  # --- Checksums over exactly those. Same idiom the core repo uses to verify its vendored prover, and
  # what the deploy gate re-checks after downloading. The names expand before the redirect creates the
  # file, so SHA256SUMS never lists itself.
  # shellcheck disable=SC2086 -- deliberate word splitting: $assets is a space-separated list.
  ( cd artifacts && sha256sum $assets > SHA256SUMS )
  cat artifacts/SHA256SUMS

  write_notes
  local release_id
  release_id="$(resolve_release_id)"

  for name in $assets SHA256SUMS; do
    # Braces, not a bare $name: bash folds a following multibyte character into the parameter name,
    # and `set -u` then kills the job on an "unbound variable" that is really a punctuation mark.
    echo "Uploading ${name}…"
    curl -sSf -X POST -H "$AUTH" -H "Content-Type: application/octet-stream" \
      --data-binary @"artifacts/$name" \
      "https://uploads.github.com/repos/${REPO_SLUG}/releases/${release_id}/assets?name=${name}" \
      -o /dev/null
  done
  echo "Release $TAG published: https://github.com/${REPO_SLUG}/releases/tag/${TAG}"
}

AUTH="Authorization: Bearer ${GITHUB_TOKEN:-}"

case "$CMD" in
  resolve) resolve ;;
  guard) guard ;;
  tag) tag ;;
  publish) publish ;;
  *)
    echo "usage: bash scripts/ci/release.sh <resolve|guard|tag|publish>" >&2
    exit 2
    ;;
esac
