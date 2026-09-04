#!/usr/bin/env bash
#
# deploy-production.sh — the approved production-deploy step. A STUB: it verifies the published
# artifact and prints the publish command it would run, because there is no Chrome Web Store listing
# to publish to yet.
#
# Deliberately not a pure no-op: an approval gate that verifies nothing teaches nothing. It resolves
# the GitHub Release for the tag, downloads the production zip and its checksums, and proves the
# bytes that would be published are intact. curl + sha256sum only — no npm install, no unzip.
#
# Called as `bash scripts/ci/deploy-production.sh` from the tag-triggered `production_deploy`
# workflow (see .circleci/config.yml).
#
# Environment:
#   REPO_SLUG     owner/repo (set by the executor)
#   GITHUB_TOKEN  contents:read is enough here (org-wide context org-global)
#   CIRCLE_TAG    the tag that triggered this pipeline, e.g. v1.0.0
set -euo pipefail

: "${REPO_SLUG:?REPO_SLUG must be set (the CircleCI executor sets it)}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set (org-wide context org-global)}"
: "${CIRCLE_TAG:?CIRCLE_TAG must be set — this job only runs on a tag pipeline}"

API="https://api.github.com/repos/${REPO_SLUG}"
AUTH="Authorization: Bearer ${GITHUB_TOKEN}"
VERSION="${CIRCLE_TAG#v}"
ZIP="dmarket-p2p-extension-${VERSION}-chrome.zip"

curl -sSf -H "$AUTH" "$API/releases/tags/$CIRCLE_TAG" > /tmp/release.json
node -e '
  const r = require("/tmp/release.json");
  const want = process.argv[1];
  const lines = [];
  for (const name of [want, "SHA256SUMS"]) {
    const a = (r.assets ?? []).find((x) => x.name === name);
    if (!a) {
      console.error(`ERROR: release ${r.tag_name} has no asset "${name}".`);
      process.exit(1);
    }
    lines.push(`${a.id} ${a.name}`);
  }
  require("fs").writeFileSync("/tmp/assets.txt", lines.join("\n") + "\n");
' "$ZIP"

mkdir -p /tmp/dist && cd /tmp/dist
while read -r ID NAME; do
  curl -sSfL -H "$AUTH" -H "Accept: application/octet-stream" "$API/releases/assets/$ID" -o "$NAME"
done < /tmp/assets.txt
# --ignore-missing: SHA256SUMS also covers the assets this gate has no reason to download.
sha256sum -c --ignore-missing SHA256SUMS

cat <<BANNER

==================================================================
  STUB — NOTHING WAS PUBLISHED
==================================================================
  tag      : $CIRCLE_TAG
  artifact : $ZIP ($(du -h "$ZIP" | cut -f1)), checksum verified

  There is no Chrome Web Store listing to publish to yet. When there
  is, put CHROME_* in a NEW project-scoped context (not org-global —
  these are one extension's store credentials, and org-global is
  readable by every project in the org), list it on this job next to
  org-global, and enable the block below. The command is already the
  right one:

    npx publish-extension --chrome-zip "$ZIP" --dry-run

  Env it reads (publish-browser-extension, which "wxt submit" aliases):
    CHROME_EXTENSION_ID, CHROME_CLIENT_ID, CHROME_CLIENT_SECRET,
    CHROME_REFRESH_TOKEN   — or the newer service-account pair
    CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL / _PRIVATE_KEY.
  Drop --dry-run to actually upload; add --chrome-skip-submit-review
  to upload a draft without submitting it for review.
==================================================================

BANNER

# Uncomment (and drop --dry-run when the listing is real) to make this live. The guard means filling
# the context is the only change needed. `npm ci` is required because publish-extension is a
# dependency, and this job otherwise installs nothing.
# if [ -n "${CHROME_EXTENSION_ID:-}" ]; then
#   cd "$CIRCLE_WORKING_DIRECTORY"
#   npm ci
#   npx publish-extension --chrome-zip "/tmp/dist/$ZIP" --dry-run
# fi
