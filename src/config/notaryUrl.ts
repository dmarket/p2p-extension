/**
 * The notary WebSocket the TLSN prover attests through: the compiled default, and the precedence that
 * resolves it against the two things allowed to override it.
 *
 * Its own module beside src/config/dmarketSite.ts, which resolves the DMarket FE the same way and for the
 * same reason — both were a surface reporting one endpoint while the core ran on another. Two ordering
 * regressions have already been fixed in this precedence (see `resolveNotaryUrl`), and while it lived
 * inline in the service-worker entrypoint the only thing pinning the order was a comment: entrypoints are
 * `defineBackground` modules with no test file. Here it is a pure function with a table.
 */

/**
 * The deployed production notary — the same value as the core's own default for the same field
 * (`NotaryConfig.PRODUCTION_NOTARY_URL`), and pinned to it by a test rather than by this sentence.
 *
 * Two copies, deliberately: the core needs a default so a host that configures nothing still attests
 * through a real notary, and we need one because the debug console reports the notary the tracker was
 * actually started with. See the drift assertion in notaryUrl.test.ts for why the pairing is a test.
 */
export const PROD_NOTARY_URL = 'wss://api.dmarket.com/provenance/v1/';

/**
 * The notary a build boots with when nothing overrides it — and every build has one.
 *
 * A missing notary URL is not a degraded mode: the core falls back to the no-op prover, which submits an
 * empty `proofPayload` by design, so any deal the backend marks `proofRequired` cannot settle and nothing
 * says why. Production used to have no default at all and took the URL from remote config only, which made
 * arming the real prover depend on a publish that might never happen.
 *
 * Dev builds prefer the dev notary when the gitignored .env configures one (`WXT_DEV_NOTARY_URL` — same
 * reason as the endpoint defaults in the service worker: the repository carries no internal hostnames) and
 * fall back to production otherwise. `import.meta.env.DEV` is a compile-time constant, so that arm and the
 * variable with it are dead code in a shipped bundle.
 */
export const DEFAULT_NOTARY_URL = import.meta.env.DEV
  ? import.meta.env.WXT_DEV_NOTARY_URL || PROD_NOTARY_URL
  : PROD_NOTARY_URL;

/**
 * Resolve the notary URL to hand the core, or `undefined` to leave the slot unset (→ the core's own
 * default). Precedence: the debug console > a PUBLISHED `tracker.notary.notaryUrl` > {@link
 * DEFAULT_NOTARY_URL}.
 *
 * | `consoleOverride` | `published` | result |
 * |---|---|---|
 * | a URL | anything | the console's URL |
 * | `null` (operator cleared it) | a URL | the published URL |
 * | `null` | absent | `undefined` — the core's own default |
 * | `undefined` (console never spoke) | a URL | the published URL |
 * | `undefined` | absent | {@link DEFAULT_NOTARY_URL} |
 *
 * Both prior bugs here were ordering, which is why the table is the test:
 *  - the build default must NOT outrank a publish. It did once, and a substrate's own notary was silently
 *    replaced by the dev one from `.env`, which then rejected that substrate's fixture CA as
 *    `UnknownIssuer` — a failure that looks exactly like a broken `rootStorePem`.
 *  - "the console never spoke" and "the operator cleared it" must resolve differently, which is why
 *    `consoleOverride` is three-state rather than two. Seeding it with the build default collapsed them.
 */
export function resolveNotaryUrl(
  published: string | undefined,
  consoleOverride: string | null | undefined,
): string | undefined {
  if (consoleOverride) return consoleOverride;
  // Cleared: beats the build default but not a publish. With no publish this reaches the core's own
  // default, which is the only route left to the no-op prover on a core that still gates on this URL.
  if (consoleOverride === null) return published;
  return published ?? DEFAULT_NOTARY_URL;
}
