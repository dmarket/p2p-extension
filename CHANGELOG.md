# Changelog

All notable changes to the DMarket Trade Tracker browser extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/).

**Releases are automated.** Branch off as `release/vX.Y.Z`, bump `version` in `package.json` to match,
add the matching section here, and push: after a manual approval CI tags `v<version>` and publishes a
GitHub Release whose notes are this file's section for that version, with the installable zip attached.
A push whose version already has a tag releases nothing, so re-pushing is safe. See "CI & releases" in
the README.

## [Unreleased]

Built against `@dmarket/p2p-tracker-core` `1.2.0-beta`, which ships the TLSN prover from
`steam-provenance` `v1.0.1` (`3fe3354`).

### Added

- **Suspicious Steam offer warnings (DMA-819).** On the sent-offers page and on an offer's own page
  (`/tradeoffer/<id>/`) a banner marks an outgoing offer that gives items away with no DMarket deal
  behind it (yellow, dismissible with "I know this partner") or one whose partner poses as DMarket
  (red: an account in `web.knownScamPartners`, or a persona name like "D market"); a received offer
  from a known scam account that asks for the seller's items is red too. The toolbar icon shows a
  "!" badge and the popup a line while such an offer is open. Nothing is cancelled or blocked, and
  nothing reaches Steam Mobile, where offers are confirmed. Verdicts come from the core (DMA-818);
  an older core leaves only the known-account check. Remote config: `web.offerSelectors`,
  `web.offerPageAnchorSelector`, `web.knownScamPartners`. Debug builds get "Simulate suspicious
  offer" in the console.
  - The popup line is a centred card in a band reserved above the icon on every home screen: it opens
    together with the screen, never moves it, keeps the Steam Mobile advice, and hides the activity pill
    while shown.
  - A received offer from an account whose persona name poses as DMarket is red too once DMarket says
    it is not one of its bots' offers, with its own copy ("… poses as a DMarket bot"). Remote config:
    `tracker.receivedOfferNameCheck` (on for stage, where QA tests it; off for prod until QA confirms a
    live "yes") and `tracker.isTradeOurGraceMs`. Needs the core version that carries both; an older one
    is not handed them.
- **Support logs (DMA-678).** The extension keeps the last 24 hours of its own activity on the device:
  tracker events, trade-proof progress, sign-in and activation changes. Help → Troubleshooting saves it
  as a file or copies it to the clipboard, so a seller can hand it to support. Before anything is saved,
  the screen says what the file contains: Steam ID, DMarket account ID and deal ids. Credentials are
  never written to it, and it leaves the device only if the seller sends the file. Switching error
  reporting off clears it.
- **Failed trade proofs are reported, with diagnostics (DMA-516).** When a proof cannot be produced or
  delivered, the reason goes to the error collector (`core: notary proof failed …`). A proof that fails
  or times out also reports where it stopped: the stage, how long it waited, the bytes exchanged with
  the notary and with Steam, the thread count and the prover build, with no account or deal ids. Proofs
  the backend rejected, suppressed proofs and reports held back for a proof are reported too. Proof
  reports have their own daily budget (50) and never use up the budget for crash reports. A remote
  setting, off by default, can end a proof whose notary connection went silent instead of waiting out
  the deadline.
- **Forced updates (paused, not active in this release).** The extension can read the oldest version
  allowed to keep working from the remote configuration, ask Chrome for the update and report where it
  stands to dmarket.com (`pong.update`). The published configuration sets no minimum and CI does not
  raise one, so no install is asked to update and `pong.update` reports `required: false`.

### Fixed

- **A broken offer selector no longer erases the yellow Steam offer warnings (DMA-859).** When
  `web.offerSelectors.offer` missed the offer blocks on `/tradeoffers/sent/` (a Steam markup change or a
  bad publish), the empty scan was read as "no open offers" and every yellow verdict was dropped; the
  core reports an offer once, so the warnings did not come back after the selector was fixed. The page
  now prunes only when the selector matched every `tradeofferid_` block on it, and an open offer the
  core already reported (its `tracker_guard_notified` record) gets its warning back the next time the
  sent page lists it, which also heals installs that lost the warning before this fix.
- **Closed Steam offers are no longer flagged as suspicious (DMA-849).** Steam keeps recently accepted,
  canceled and declined offers on `/tradeoffers/sent/`; the page now skips any offer without footer
  actions (`web.offerSelectors.active`), so a closed offer to a known scam account is neither warned
  about nor counted in the badge and popup. A partner taken off `web.knownScamPartners` also loses the
  warnings only the page raised for it, at once instead of after the 24 h TTL.
- **Messages from other extensions and pages are refused (DMA-813).** Every `runtime.onMessage`
  handler checks that the sender is this extension's own page or content script before it acts.
- **The Steam credential leaves the device with the extension (DMA-817).** Deactivating, and a
  DMarket sign-out that lasts, remove the stored Steam web token. The token is kept in
  `storage.session`, which Chrome holds in memory, so it is not written to disk and is gone when the
  browser closes; a token an older version left in `storage.local` is removed when the updated
  extension starts.
- **`storage.local` and `storage.session` are closed to content scripts (DMA-816).** The Steam page
  and the dmarket.com bridge ask the worker for the few keys they read and get their changes pushed,
  so a page renderer can neither read the Steam token nor rewrite the remote config. Firefox, which
  has no storage access levels, is unchanged.
- **Error reports no longer carry the dmarket.com device id.** Each report's device id was the site's
  analytics cookie (`dm_did`), which ties a report to the browser's web session. It is now a random
  install id that switching reporting off erases, and the reporter reads no cookies. Reports also scrub
  deal, offer and trade ids and the query values of bare request paths. The toggle now reads "Send
  technical error reports", and its tooltip lists everything a report carries.
- **Updates install without a browser restart.** Chrome installs an update only while the extension
  is idle, and the document that runs the trade-proof engine kept it from ever being idle, so updates
  waited until the seller restarted Chrome. The extension now reloads onto a downloaded update as soon
  as no proof is running.

### Changed

- **`CreateTrade` from dmarket.com is a trigger, not an order (DMA-814).** The extension takes only
  `deal_id` from the frame; the core fetches the deal's `create_offer` directive from the backend
  (`POST /p2p/deals/{id}/create-trade`) and builds the Steam offer from it, so a script on the page
  can no longer choose the counterparty. `directive_id`, `partner_steam_id`, `asset_ids`,
  `trade_token` and `linked_steam_id` are accepted and ignored; the page must keep sending them
  while 1.0.5 and older are installed, since those drop a frame missing any of them. Reply frames
  and `reason` codes are unchanged. The `ack` arrives after the directive call plus the Steam POST;
  waiting stops at 30 s with `ack` `failed`/`OTHER` while the create carries on. A deal with no
  directive gets `failed`/`OTHER` and no Steam write.
- **Trade proofs run on the `steam-provenance` `1.0.1` prover**, shipped with core `1.1.0-beta`.
  `1.0.5-beta` ran the `99e090a` build.
- **Remote configuration comes from the DMarket CDN (DMA-484)** instead of Firebase Remote Config,
  revalidated hourly by default and with a 15-minute back-off after a failed fetch. The Firebase host
  permission is removed.
- **Fewer remotely tunable settings.** Steam base URLs and query-parameter names, the notary protocol
  names, the Steam profile and game groups, the bridge's extra origins and the trigger debounces are no
  longer settable remotely; they could not do anything useful and some could widen what the extension
  accepts.
- **The extension reports its own version** to dmarket.com (`pong.version`) and to the backend
  (heartbeat `clientVersion`), instead of the core library's.

### Engineering

- **The debug build reaches the QA autotests without a CircleCI token.** After every green
  `build-debug` on `main`, CI uploads the debug zip over `latest.zip` in a private stage Cloud Storage
  bucket (`publish_debug_build`), with the version, commit and build in the object's metadata.
- **Debug builds start on Stage.** A debug build boots against the Stage environment (API, FE and its
  own notary) when the build environment configures it, else Dev, else Prod; the debug console's Stage
  preset is the highlighted one.

## [1.0.5-beta] - 2026-09-23

Built against `@dmarket/p2p-tracker-core` `1.0.3-beta`.

### Fixed

- **Trade offers are created after a browser restart, without opening Steam first.** Closing the browser
  drops a short-lived Steam cookie that every offer and cancel has to carry, while the Steam login itself
  survives. Until the seller opened any Steam page, the extension looked for that cookie, did not find
  it, and failed the offer with "no Steam session cookie" without contacting Steam, so the deal could run
  out of time. It now asks Steam for a fresh cookie first and fails only if Steam does not give one.

## [1.0.4-beta] - 2026-09-23

Built against `@dmarket/p2p-tracker-core` `1.0.2-beta`.

### Fixed

- **A trade offer Steam closed is replaced by a new one, instead of by its own dead id.** When Steam
  cancelled the seller's offer before it went anywhere (most often at the mobile confirmation step, but
  also expired, declined or with items no longer available), DMarket asks for a fresh offer. The
  extension answered that request with the id of the offer Steam had just closed and sent nothing to
  Steam, so the deal stalled on an offer that no longer existed while the buyer's payment stayed held.
  It now creates the new offer.
- **A cancel that fails now tells DMarket why.** Steam's own reason travels with the failure, so an offer
  Steam has already closed is no longer indistinguishable from a network blip.

## [1.0.3-beta] - 2026-09-14

Built against `@dmarket/p2p-tracker-core` `1.0.1-beta`.

### Fixed

- **Trade tracking now really does stop until the user turns it on.** Activation controlled the toolbar
  icon, the popup screen and the Steam banner — and nothing else. The extension started its tracker on
  every run regardless, so an install whose onboarding was never completed still contacted DMarket (which
  recorded that person as an online seller), still created Steam trade offers when the website asked for
  one, and still produced the proofs that carry a deal through to completion, all while telling
  dmarket.com that it was not tracking. That is why the same seller was refused when they tried to list
  an item: one extension, two opposite answers about itself. Activation now gates the tracker itself —
  before it there is no contact with DMarket, no presence, and no Steam trade offer. Pressing Activate
  starts tracking at once rather than at the next scheduled check, and turning it off stops it.
- **A seller who never finished onboarding is no longer recorded as having refused a trade.** When the
  deadline to create a trade passes, DMarket separates a seller it could not see — the deal is frozen and
  looked at — from one who declined, which counts against them. An un-activated extension reported itself
  present the whole time, so a seller who had never been told there was anything to do took the second
  branch.
- **Re-enabling the extension re-checks your sessions instead of trusting what it remembered.** Signing
  out of DMarket or Steam while the extension was disabled — or during a reload, an update or a browser
  restart — left it showing "Trade tracking is ON" with a green icon, and telling dmarket.com the same,
  for up to a minute or two after it came back: nothing had been awake to notice the sign-out, and the
  next scheduled check was not yet due. The first start of a browser session now checks both sessions
  immediately.

## [1.0.2-beta] - 2026-09-11

Built against `@dmarket/p2p-tracker-core` `1.0.1-beta`.

### Fixed

- **Presence is answered after the core has booted, instead of from the pre-boot defaults.** The page
  bridge is registered on every worker spawn, but the core handle only exists once the boot finishes.
  Asked in between, the extension reported itself as activated, unblocked and not tracking — three
  claims that cannot all be true. Chrome evicts an idle worker after about 30 seconds, so on a quiet
  page that was the answer most requests got, and dmarket.com showed a set-up prompt over a working
  install. A presence request now waits for the boot, capped at a second.
- **Re-enabling the extension restores the page bridge in tabs that were already open.** Disabling and
  re-enabling leaves those tabs with an orphaned content script and raises no install event, so nothing
  was re-injected and the page kept timing out until someone reloaded it. The first worker spawn of a
  browser session now re-injects once, which is what being enabled looks like from the inside.

## [1.0.1-beta] - 2026-09-08

Built against `@dmarket/p2p-tracker-core` `1.0.1-beta`.

### Changed

- The debug console marks a directive the core refuses, and stops marking a report the core
  deliberately sent unproven.

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

[1.0.5-beta]: https://github.com/dmarket/p2p-extension/compare/v1.0.4-beta...v1.0.5-beta
[1.0.4-beta]: https://github.com/dmarket/p2p-extension/compare/v1.0.3-beta...v1.0.4-beta
[1.0.3-beta]: https://github.com/dmarket/p2p-extension/compare/v1.0.2-beta...v1.0.3-beta
[1.0.2-beta]: https://github.com/dmarket/p2p-extension/compare/v1.0.1-beta...v1.0.2-beta
[1.0.1-beta]: https://github.com/dmarket/p2p-extension/compare/v1.0.0-beta.1...v1.0.1-beta
[1.0.0-beta.1]: https://github.com/dmarket/p2p-extension/releases/tag/v1.0.0-beta.1
