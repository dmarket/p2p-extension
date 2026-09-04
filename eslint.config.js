import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// ESLint flat config. Run with `npm run lint`.
//
// FORMATTING IS NOT LINTED, deliberately: there is no Prettier here and no stylistic rule set. This
// repository is indented by hand, and running a formatter over it rewrites whole files (a single
// `npx prettier` pass once produced 179 insertions / 96 deletions for a 17-line change). Every rule
// below is about behaviour or types.
//
// SEVERITY POLICY — the reason `npm run lint` can be a gate on day one, on a codebase that has never
// been linted:
//   - `error` = a finding is, in this codebase, likely a defect. These must stay at zero, and they are.
//   - `warn`  = ADVISORY: the rule is sound in general but does not fully apply to this stack, so a
//               finding is a prompt to look rather than a defect. Warnings do not fail the command.
//
// Both tiers are currently empty. The `warn` tier started as a backlog of deliberate-or-cosmetic sites and
// was worked to zero; the rules whose sites were REAL (a nullable `reject`, an `as Promise<T>` supplying a
// generic) were promoted to `error` at that point, because the whole reason to fix them was that this
// repository has no CI and `npm run check` is the only gate — leaving them advisory would let the exact
// regression just paid for land invisibly. Demote a rule here only when it genuinely does not apply, and
// say why in a way that stays true once the current sites are gone.
//
// Nothing is `off` to hide a finding — the two suppressions in the tree are inline, each with a reason.
export default tseslint.config(
  {
    ignores: [
      '.output/**', // build artifacts
      '.wxt/**', // WXT-generated types
      'coverage/**',
      'public/**',
      // node_modules is in flat config's default ignores, so it is deliberately not listed.
    ],
  },

  js.configs.recommended,

  // Type-aware linting. Viable here because `tsc` already runs with `strict`,
  // `noUncheckedIndexedAccess`, `noUnusedLocals` and `noUnusedParameters`, so the `no-unsafe-*` family
  // — usually the reason a codebase cannot afford this tier — reports almost nothing.
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        // Uses the project's own tsconfig.json (which includes the repo root), so a file added outside
        // src/ is linted with types automatically instead of erroring as "not found in any project".
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The single most valuable rule for this codebase: an MV3 service worker can be terminated at any
      // await, and a dropped promise is how a cycle dies with no event. Kept an error even though it
      // currently reports nothing — the `void` prefix idiom this code already uses is what satisfies it.
      '@typescript-eslint/no-floating-promises': 'error',

      // A zero-width space is used on purpose inside JSDoc to stop `*/` in a path pattern from closing
      // the comment (see src/infra/report/describe.ts) — a trap this project has hit before. Irregular
      // whitespace in actual CODE is still an error.
      'no-irregular-whitespace': ['error', { skipComments: true, skipJSXText: true }],

      // ---- Promoted from the initial `warn` backlog, now that their sites are gone ----------------
      // Each of these reported real work, was cleared, and is an error so the same shape cannot return.
      //
      // A redundant `as T` is rarely just noise here: on `browser.runtime.sendMessage`, whose signature is
      // `<M = any, R = any>(message: M): Promise<R>`, the assertion is what SUPPLIES `R` — so the value
      // stays typed only while the assertion or the return annotation survives, and silently becomes `any`
      // if either is edited away. The type belongs in the call's own type argument instead.
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // `X | unknown` collapses to `unknown`, so a union written to document "may not have booted yet" was
      // invisible to the compiler — which is how `TrackerHandle | undefined` came to accept `undefined`
      // where a live handle was required (see the brand in src/core/tracker.ts).
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      // `IDBRequest.error` / `IDBTransaction.error` are nullable and an aborted transaction carries no
      // error at all, so this caught a `reject(null)` — a rejection a `catch` block cannot read.
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      // An `async` function with nothing to await is usually scaffolding around a synchronous call that has
      // been mistaken for an asynchronous one (it was, in the report relay).
      '@typescript-eslint/require-await': 'error',
    },
  },

  // Preact components.
  //
  // Only `rules-of-hooks` and `exhaustive-deps` are errors: they key on the `use*` naming convention
  // alone, so they hold for preact/hooks exactly as for React. The rest of this plugin's set (v7 ships
  // the React Compiler rules — immutability, purity, use-memo, gating, …) exists to guarantee code that
  // compiler can safely transform, and Preact has no such compiler — so those stay ADVISORY rather than
  // being promoted with the rules above. They earn their place anyway: they are what found a mutated hook
  // return value and a `Date.now()` read during render in the debug console, both of which are smells in
  // any framework and both now fixed.
  //
  // Their cost is measured, in case a future reader wants to trade it away: enabling the set adds ~500 ms
  // to a ~3.5 s `eslint .` (interleaved A/B, 6 reps). It is all-or-nothing — `TIMING=1` blames one rule for
  // most of it, but disabling that rule alone saves ~30 ms, because the cost is shared traversal that
  // simply re-attributes to whichever rule runs next.
  {
    files: ['**/*.tsx'],
    plugins: reactHooks.configs.flat['recommended-latest'].plugins,
    rules: {
      ...Object.fromEntries(
        Object.keys(reactHooks.configs.flat['recommended-latest'].rules).map((rule) => [rule, 'warn']),
      ),
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // KEEP THE TEST FRAMEWORK OUT OF THE SHIPPED BUNDLE.
  //
  // Tests are colocated (`src/util/redact.test.ts` beside `src/util/redact.ts`) — the ecosystem default,
  // and it keeps a missing test visible and stops a test outliving the module it covers. The `*.test.ts`
  // files themselves cannot reach a bundle: WXT bundles from entrypoints, and nothing imports one.
  //
  // Their SHARED FIXTURE can, and that is the one hole colocation opens here. `src/testing/stubs.ts` is an
  // ordinary module inside `src/` that imports `vitest` and `wxt/testing/fake-browser`, so a production module importing
  // it would pull the test framework and the fake browser into the extension — and neither `tsc` nor the
  // guard scripts would say a word (verified: a probe file doing exactly that compiled and linted clean).
  // Convention alone was carrying this; now the linter is.
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/testing/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vitest',
              message: 'Test-only. Importing vitest from production code ships it in the extension bundle.',
            },
          ],
          patterns: [
            {
              group: ['**/testing/*', '@/testing/*'],
              message:
                'src/testing/ is test-only and imports vitest — importing it here ships the test framework in the extension bundle.',
            },
          ],
        },
      ],
    },
  },

  // Plain-JS files: the guard checkers wired into `npm run compile`, and this config itself. None are in
  // tsconfig, so type-aware rules cannot apply and must be switched off per file or every one of them
  // fails with "don't have parserOptions set to generate type information". `no-undef` is also live here
  // (typescript-eslint only disables it for TS files), hence the node globals.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: globals.node },
  },

  // Build config. WXT types the generated manifest loosely (`host_permissions` and friends are `any`),
  // so spreading it is unavoidably "unsafe" and no cast would make it truthful.
  {
    files: ['wxt.config.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },

  // Tests: `expect(bad as never)`-style probing of a guard's negative cases means deliberately passing
  // wrong types, and asserting on a rejection means handling promises loosely.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'vitest.setup.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },
);
