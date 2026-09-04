import { resolve } from 'node:path';

/**
 * The bundler alias for the core's DOMAIN sub-module, shared by `wxt.config.ts` and `vitest.config.ts`.
 *
 * The core's config classes (`TrackerConfig` and its groups) live in this file and are NOT re-exported
 * from the package main, and it has no package export of its own — so both the build and the test run
 * have to be told where it is. The TypeScript side is covered separately by the ambient declaration in
 * `src/core/core-domain.d.ts`.
 *
 * Shared rather than spelled in both configs because the two must resolve to the SAME file, and nothing
 * would say so if they stopped: `src/core/config.test.ts` exists to prove the positional `copy()` contract
 * against the real compiled module, and this project's documented way to test a core change is to overlay
 * locally-built artefacts. If the build alias moved and the test alias did not, that suite would keep
 * passing against the old module — the exact failure `scripts/check-core-params.mjs` exists to catch,
 * passing quietly.
 *
 * A standalone module rather than an export from `wxt.config.ts` so the vitest config does not drag the
 * whole wxt/preact config graph in to read one path.
 */
export const CORE_DOMAIN_ALIAS = {
  find: /^@dmarket\/p2p-tracker-core-domain$/,
  replacement: resolve(
    import.meta.dirname,
    'node_modules/@dmarket/p2p-tracker-core/dmarket-p2p-tracker-core-domain.mjs',
  ),
} as const;
