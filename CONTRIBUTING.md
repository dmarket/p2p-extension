# Contributing

Thanks for your interest in improving the DMarket Trade Tracker extension. This document covers how to
build the project, the conventions we follow, and how changes get released.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md). For security issues,
**do not open a public issue** — follow the [Security Policy](SECURITY.md) instead.

## Prerequisites

- **Node.js 22 or newer** and npm. `npm install` runs `wxt prepare`, which generates the TypeScript
  project files under `.wxt/`.
- Chrome (or any Chromium) for loading the unpacked build. No `.env` is required: every integration
  is a no-op until its variables are set — see [`.env.example`](.env.example).

## Build & test

```bash
npm install
npm run check          # everything CI runs: compile (tsc + guard scripts), lint, tests
npm run compile        # type-check + the guard scripts only
npm run lint           # ESLint (type-aware); `npm run lint:fix` to auto-fix
npm test               # Vitest; `npm run test:watch` for watch mode
npm run build:debug    # development build with the debug console -> .output/chrome-mv3-dev
npm run build          # production build (no debug tooling)     -> .output/chrome-mv3
```

Please make sure `npm run check` is green before opening a pull request. Load `.output/chrome-mv3-dev`
unpacked via `chrome://extensions` → Developer mode → **Load unpacked** to test by hand.

## The guard scripts

`npm run compile` runs three scripts under `scripts/` besides `tsc`. They exist because the tracker core
is consumed through a positional Kotlin/JS constructor contract that the TypeScript compiler cannot check:

- `check-core-params.mjs` — the config parameter orders in `src/config/coreParams.ts` must match the
  installed core's constructors by name and arity. If this fails after a core bump, update the orders
  in the same commit; a mismatch would write one field's value into another field's slot.
- `check-surface-priority.mjs` — the blocking-state precedence table (`src/state/surface.ts`) and the
  reason allow-list, asserted for every input combination.
- `check-create-trade-cause.mjs` — the create-trade failure causes on the wire match the core's.

## Conventions

- **TypeScript, strict.** `noUnusedLocals` / `noUnusedParameters` are on; dead code fails `compile`.
- **Formatting is by hand** — there is no Prettier and no stylistic lint rules. Match the surrounding
  code. Do not run `npx prettier` on this repository.
- **`void` a promise you deliberately do not await.** `no-floating-promises` is an error: a dropped
  promise is how a service-worker cycle dies silently.
- **Keep `src/debug/` dev-only.** Production must never import from it; the dependency may only run
  the other way. `scripts/verify-build.mjs` checks a production bundle for debug symbols.
- **Never widen permissions casually.** Adding a host permission is a privilege increase that disables
  the extension for existing users until they re-accept. `verify-build.mjs` pins the production
  permission set.
- **Redaction.** Anything that can reach a log or an error report goes through `src/util/redact.ts`.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `ci:`,
`refactor:`, `test:`, `chore:`, with an optional scope, e.g. `fix(popup): keep the spinner until the
first storage read resolves`.

## Pull requests

1. Branch off `main`.
2. Keep changes focused; add or update tests for behavior you change.
3. Run `npm run check` locally.
4. Open a PR and fill out the template. CI (`check` and `build-prod`) must be green and the PR needs
   one approving review before it can be merged.

## The CI badge token

The CircleCI badge URL in [`README.md`](README.md) carries a `circle-token` query parameter. That is
deliberate and not a leaked secret: the CircleCI project is kept private even though this repository is
public, so an unauthenticated badge cannot render, and CircleCI's documented answer for that is a
**status-scoped** project token, which can read nothing but the badge status. Do not "fix" it by
deleting the parameter — the badge simply breaks.

## How releases work

Releases are driven by a version bump merged to `main` and approved in CircleCI — never create git
tags by hand. The full procedure is in the [README](README.md#cutting-a-release).
