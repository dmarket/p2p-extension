import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { CORE_DOMAIN_ALIAS } from './core-domain-alias';

// Vitest config for the unit suite (`npm test`).
//
// `WxtVitest()` reads wxt.config.ts and supplies the four things a WXT module needs to run outside a
// browser: the `@/` → src alias, WXT's `import.meta.env.*` globals (MANIFEST_VERSION / BROWSER /
// FIREFOX / …), unimport so the auto-imported globals this codebase relies on (`browser`,
// `defineBackground`, `createShadowRootUi`, …) resolve without an import statement, and an alias that
// points `wxt/browser` at @webext-core/fake-browser — so `browser.storage.local` in a test is an
// in-memory implementation, not undefined.
//
// What it deliberately does NOT do is apply the `vite` block from wxt.config.ts, so anything the build
// injects there has to be repeated below. Both entries are load-bearing: without them the modules that
// depend on them fail at import time, not at assertion time.
export default defineConfig({
  plugins: [WxtVitest()],
  define: {
    // Injected by the build (wxt.config.ts → buildId()). src/infra/report/payload.ts reads it at module
    // scope, so an undefined identifier is a ReferenceError on import. The value only has to be a string;
    // a test asserting on a real SHA would be asserting on the checkout.
    __BUILD_ID__: JSON.stringify('test'),
  },
  resolve: {
    // THE SAME constant wxt.config.ts uses, not a second copy of the path: a test gets the exact module
    // instance the extension does, so `instanceof` and the positional `copy()` contract behave identically
    // — and src/core/config.test.ts, whose whole job is to prove that contract, cannot end up asserting it
    // against a different build of the core than the one being shipped.
    alias: [CORE_DOMAIN_ALIAS],
  },
  test: {
    // Colocated with the code they cover. Nothing outside src/entrypoints is an entrypoint, so these
    // files are invisible to the build — WXT bundles from entrypoints, and nothing imports a *.test.ts.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Node by default: every module worth covering here is logic (redaction, validation, protocol
    // guards, priority resolution), and fake-browser needs no DOM. A component test can opt in per file
    // with `// @vitest-environment jsdom` once jsdom is installed — it is not a dependency today.
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // The fake browser is module-level singleton state shared by every test in a file; isolate per file
    // rather than relying on discipline. `unstubGlobals`/`unstubEnvs` undo `vi.stubGlobal` (the fetch
    // stub in src/testing/stubs.ts) and `vi.stubEnv` after each test for the same reason.
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // The JUnit report for CircleCI's `store_test_results`, which is what turns a failure into a named
    // test in the UI instead of a wall of log. `addFileAttribute` is the form vitest documents as
    // validated on CircleCI.
    //
    // Written on EVERY run, deliberately NOT gated on `process.env.CI` — that gate was a bug. Whether
    // the report exists then depends on an environment variable set outside this repository, and when
    // it is missing CircleCI says only "we detected the store_test_results key but there is an issue
    // with the output" — indistinguishable from a malformed report, and it points at the wrong half of
    // the system. Store steps run even after a failed step, so the file simply has to be there. The
    // cost is one gitignored 56 kB file per local run.
    reporters: ['default', ['junit', { outputFile: 'test-results/junit.xml', addFileAttribute: true }]],
  },
});
