<!--
Thanks for contributing! Please keep the PR focused and fill out the sections below.
See CONTRIBUTING.md for build, style, and release conventions.
-->

## Summary

<!-- What does this change do, and why? -->

## Type of change

- [ ] `fix` — bug fix
- [ ] `feat` — new feature
- [ ] `docs` / `ci` / `refactor` / `test` / `chore` (no user-facing behavior change)

## Related issues

<!-- e.g. Closes #123 -->

## How was this tested?

<!-- Commands run, cases covered, and whether you loaded the unpacked build in a browser. -->

- [ ] `npm run check` passes locally

## Checklist

- [ ] No new host permission or manifest permission (or the increase is called out above and in `scripts/verify-build.mjs`)
- [ ] Nothing under `src/debug/` is imported from production code
- [ ] New or changed logic has Vitest coverage
- [ ] Updated `CHANGELOG.md` under the upcoming version if this is user-facing
- [ ] No secrets, tokens, or credentials are included in the diff
