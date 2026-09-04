# DMarket Trade Tracker

<!--
  `circle-token` below is a CircleCI status-badge token: read-only, scoped to this branch's build
  status alone (no logs, artifacts, env, contexts or pipeline control). A private project's badge 404s
  without it, hence it is committed. Rotate in Project Settings → Status Badges; drop the parameter
  once this repo is public — public badges need no token.
-->

[![CircleCI](https://dl.circleci.com/status-badge/img/gh/dmarket/p2p-extension/tree/main.svg?style=shield&circle-token=CCIPRJ_KSg6ehUbqZjU39e6DXJv8U_e3345193ce36d1c052b935d3d7797834724f944d)](https://dl.circleci.com/status-badge/redirect/gh/dmarket/p2p-extension/tree/main)

A browser extension (Chrome, Manifest V3) that watches your Steam trade offers and verifies P2P
trades against your DMarket deals. It bundles the DMarket P2P trade-tracker core (compiled from
Kotlin Multiplatform) and drives it from a Manifest V3 service worker.

> The trade-tracker business logic lives in a separate library, consumed as the published npm package
> `@dmarket/p2p-tracker-core` behind a single import seam (`src/core/tracker.ts`). This repository owns
> the extension shell: the service worker, the popup, the on-page onboarding UI, and the page bridge.

## Requirements

- Node.js 22+ (WXT's own floor)
- npm 10+
- A Chromium-based browser for loading the unpacked build

## Getting started

```bash
npm install          # installs deps and runs `wxt prepare`
npm run dev          # dev build with hot reload (Chrome); includes the debug console
npm run build:debug  # loadable debug build → .output/chrome-mv3-dev (debug console included)
npm run build        # production build → .output/chrome-mv3 (debug tooling excluded)
npm run zip          # packaged production zip
npm run zip:debug    # packaged debug zip (same build as build:debug, zipped)
npm run check        # the full gate: compile (tsc + guards) + lint + unit tests
npm run compile      # type-check and guard scripts only
```

Load the unpacked extension via `chrome://extensions` (Developer mode → Load unpacked): use
`.output/chrome-mv3-dev` for a debug build or `.output/chrome-mv3` for a production build.

## Configuration

Copy `.env.example` to `.env` and fill in the values you need. Every integration (error reporting,
remote config) is optional and stays inactive until its variables are present, so the
extension builds and runs with an empty `.env`. Only `WXT_`-prefixed variables are exposed to the
bundle.

## Debugging

The extension ships a **debug console** — a developer-only dashboard for inspecting the tracker at
runtime. It is compiled into development builds only and is stripped entirely from production builds
(`npm run build` / `npm run zip`).

Build a loadable debug build and load `.output/chrome-mv3-dev` unpacked:

```bash
npm run build:debug
```

Open it from the popup's “debug console” link (dev builds only), or navigate to the extension's
`debug.html`. It provides:

- a **live network log** of the core's HTTP traffic — each request as a copy-pasteable `curl`, with
  the decoded response;
- **session status**: core version, next-heartbeat countdown, and Steam/DMarket sign-in indicators;
- an **endpoint switcher** to point the tracker at different **FE** and **API** URLs (the two
  endpoints the core uses) and restart it in place, with **Prod / Stage / Dev** prefill buttons
  (debug builds default to Dev);
- a **force tick** button to trigger a heartbeat cycle on demand;
- a **`chrome.storage.local` inspector/editor** to view, edit, add, and remove persisted keys —
  including manually activating/deactivating the extension.

### Pointing Steam at a local stand-in

Steam's hosts are hard-coded in the tracker core, so the Steam-coupled flows (session refresh, trade
send, cancel) normally need a live Steam account. Set `WXT_DEV_STEAM_URL` to a local origin and a
non-production build sends every Steam request the core makes there instead — in an ordinary browser
window, with no launch flags. Only `fetch` is redirected: the Steam session cookie is still read from
the real `steamcommunity.com` origin, so set that cookie by hand for Steam to read as connected.
Unset (the default) means real Steam, and production builds ignore the variable entirely.

## CI & releases

CircleCI (`.circleci/config.yml`). Every push runs:

| Job | Waits for | What it does |
|---|---|---|
| `check` | — | `npm run compile` (tsc + the guard scripts), `npm run lint`, `npm test` |
| `build-prod` | `check` | production zip → the job's **Artifacts** tab |
| `build-debug` | `check` | development zip (debug console, internal endpoints) → **Artifacts** |

The two builds run in parallel with each other, but neither starts until the checks pass — an
installable artifact should never come from a pipeline whose own checks are red.

Both zips are meant to be installed by hand: download, unzip, then `chrome://extensions` →
Developer mode → **Load unpacked**. Each build is verified by `scripts/verify-build.mjs`, which
checks the manifest version, the production permission/host surface, the absence of debug tooling
from a production bundle, and that the TLSN prover was copied in.

### Cutting a release

1. Pin `@dmarket/p2p-tracker-core` to an exact **stable** version (`npm install`, commit the
   lockfile) — currently `1.0.0-beta.1`. A build made against a `-SNAPSHOT` core is never released:
   a snapshot can be unpublished from npm, which would make the published build unreproducible. Note
   that `npm run core:latest` deliberately moves the pin onto the newest snapshot for development
   work, so put it back before releasing.
2. Bump `version` in `package.json`. This is the single source of truth: WXT derives the manifest
   version from it, the zips are named from it, and the tag is `v` + it. A SemVer prerelease suffix
   is fine — Chrome accepts only 1–4 dot-separated integers, so WXT puts the numeric prefix in
   `manifest.version` and the full string in `version_name` (which is what Chrome shows on the
   extension card). `1.0.0-beta.1` ships as version `1.0.0` / version_name `1.0.0-beta.1`.
3. Add the matching `## [x.y.z]` section to [CHANGELOG.md](CHANGELOG.md) — it becomes the release
   notes, and the release fails without it.
4. Merge to `main`, then **approve `hold_release`** in CircleCI.

Only then does CI tag `v<version>` and publish a GitHub Release with the production zip, a sourcemaps
archive (for symbolicating crash reports), the production manifest and `SHA256SUMS`. A prerelease
version (`0.x`, or anything with a `-suffix`) is marked **Pre-release** on GitHub, so it is not
presented as the Latest release.

The debug build is deliberately **not** published — it is not what ships, and it inlines the internal
`WXT_DEV_*`/`WXT_STAGE_*` endpoints. Download it from the `build-debug` job's **Artifacts** tab in
CircleCI, on any push.

A push to `main` whose version is already tagged releases nothing, so ordinary merges are safe;
`[skip release]` in the commit message skips it explicitly.

Publishing to the Chrome Web Store is a **second, separately approved** job triggered by the tag. It
is currently a stub: it verifies the published artifact's checksum and prints the upload command
without running it, because there is no store listing yet.

## Project layout

```
src/
  entrypoints/       # service worker, popup, content scripts, and the debug page (WXT entrypoints)
  config/            # compiled-in defaults, the remote-config overlay, core parameter order
  core/              # single import seam for the tracker core
  messaging/         # typed message contracts + the dmarket.com page bridge
  state/             # activation flag and other persisted UI state
  infra/             # error reporting, remote config (opt-in)
  debug/             # developer-only debug console service-worker glue (dev builds only)
  ui/                # popup, on-page UI, and debug-console components
```

## Tech stack

- [WXT](https://wxt.dev) — Manifest V3 build framework
- [Preact](https://preactjs.com) — UI
- TypeScript

## License

See [LICENSE](LICENSE).
