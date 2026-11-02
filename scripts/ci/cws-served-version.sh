#!/usr/bin/env bash
#
# cws-served-version.sh [extension-id] — what Chrome actually gets from the store for this item.
#
# Asks the public update server (Omaha update2, no authentication — the same endpoint scripts/ci/force-update.mjs
# polls) and prints status, version, hash_sha256, size and codebase (the CRX download URL) as `key="value"` lines.
# `status="noupdate"` means the store serves nothing newer than the probe version 0.0.0, i.e. the item is not live.
set -euo pipefail

ID=${1:-leiaegebcffagcllcekifnpohnnnffpo}   # DMarket Trade Tracker BETA
curl -fsS "https://clients2.google.com/service/update2/crx?response=updatecheck&prodversion=130.0.0.0&acceptformat=crx3&x=id%3D${ID}%26v%3D0.0.0%26uc" \
  | grep -oE '(status|version|hash_sha256|codebase|size)="[^"]*"'
