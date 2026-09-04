# Changelog

All notable changes to the DMarket Trade Tracker browser extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/).

**Releases are automated.** Bump `version` in `package.json`, add the matching section here, and
merge to `main`: CI tags `v<version>` and publishes a GitHub Release whose notes are this file's
section for that version, with the installable zip attached. A push to `main` whose version already
has a tag releases nothing, so ordinary merges are safe. See "CI & releases" in the README.

## [1.0.0-beta.1] - 2026-09-04

First release. A public beta for manual installation — not published to any extension store.

Built against `@dmarket/p2p-tracker-core` `1.0.0-beta.1`, which is pinned to an exact version so
every build of a given release is reproducible.

### Added

- **Manifest V3 extension shell around the compiled Kotlin/JS trade-tracker core.** A service worker
  that boots and drives the core, a popup, the Steam on-page onboarding banner and modals, and the
  dmarket.com page bridge. Chrome is the shipping target.
- **One resolved state, one screen.** The popup, the on-page banner and the toolbar icon all render
  from a single ranked blocking reason — sign in to DMarket, sign in to Steam, wrong Steam account,
  onboarding not completed, connection error, or active tracking — so the three surfaces cannot
  disagree with each other. An unrecognised state fails closed to "paused", never to "tracking is on".
- **Steam session handling.** Anti-CSRF header rewriting (declarativeNetRequest on Chrome, blocking
  `webRequest` on Firefox), the per-domain keep-alive handshake, and minting a live session from
  Steam's persistent-login credential when one has expired — so a signed-out user is one click away
  rather than stuck.
- **TLSN notary proofs of Steam trade state.** Produced in an offscreen document's dedicated worker,
  with a proof deadline, a liveness watch that detects a wedged prover in seconds rather than
  minutes, and prover-realm recycling. A proof is submitted before the report it corroborates, and a
  report whose proof has not verified is withheld rather than refused by the backend.
- **Firebase Remote Config overlay** for tracker and web settings: every field optional, validated,
  range-gated and fail-safe, so a bad publish falls back to the compiled defaults instead of
  stopping the tracker. Endpoints, trust anchors and the definitions of what gets proven are
  deliberately not remotely settable.
- **Opt-out error reporting** to the DMarket collector, with credential and identifier redaction, a
  per-day budget, an occurrence ladder and an offline outbox. On Firefox it is opt-in, driven by the
  browser's own data-collection consent.
- **Developer-only debug console** (development builds only, stripped from production): live network
  log with redaction, session status, storage inspector/editor, endpoint switcher, force tick, retry
  proof, and a blocking-state simulator that reproduces each state by its real cause rather than by
  overwriting a flag.
- **Firefox target** — code-complete, not yet live-validated. A separate release track.

### Engineering

- Type-check, lint and a unit-test suite, plus four guard scripts that mechanise the invariants a
  test cannot: the core's positional configuration order, the blocking-state priority table, the
  create-trade cause mapping, and that a built output is the artifact we meant to ship (manifest
  version, the production permission and host surface, no debug tooling or wrapped `fetch` in a
  production bundle, and that the TLSN prover was copied in).
- CI on CircleCI: checks gate both manual-install artifacts (production and debug), which are built
  in parallel and downloadable from every push. On `main`, a version bump proposes a release, a human
  approves it, and a build made against a `-SNAPSHOT` core is skipped rather than published. Every
  release records its build id (`<sha>+core<version>`) — the same string a crash report carries as
  `appVersion`. Production deployment is a separate, approval-gated job, a stub until there is a
  store listing to publish to.

[1.0.0-beta.1]: https://github.com/dmarket/p2p-extension/releases/tag/v1.0.0-beta.1
