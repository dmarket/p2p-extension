import { describe, expect, it } from 'vitest';
import { NotaryConfig } from '@dmarket/p2p-tracker-core-domain';
import { DEFAULT_NOTARY_URL, PROD_NOTARY_URL, resolveNotaryUrl } from '@/config/notaryUrl';

// The precedence table from resolveNotaryUrl's KDoc, asserted rather than described. Both bugs this
// function has had were ordering bugs (a build default outranking a publish; "never spoke" and "cleared"
// collapsing into one state), and until this file existed the order was pinned only by a comment in an
// entrypoint that cannot be imported into a test.
describe('resolveNotaryUrl', () => {
  const PUBLISHED = 'wss://published.test/v1/';
  const CONSOLE = 'wss://console.test/v1/';

  it('the debug console wins over everything', () => {
    expect(resolveNotaryUrl(PUBLISHED, CONSOLE)).toBe(CONSOLE);
    expect(resolveNotaryUrl(undefined, CONSOLE)).toBe(CONSOLE);
  });

  it('a publish outranks the build default — the regression that cost a harness lane a false UnknownIssuer', () => {
    expect(resolveNotaryUrl(PUBLISHED, undefined)).toBe(PUBLISHED);
  });

  it('with nothing else, the build default applies — every build boots with a notary', () => {
    expect(resolveNotaryUrl(undefined, undefined)).toBe(DEFAULT_NOTARY_URL);
    expect(DEFAULT_NOTARY_URL).toBeTruthy();
  });

  it('"cleared" and "never spoke" resolve differently: a clear takes no build default', () => {
    // The whole reason the console value is three-state. A clear leaves a publish standing…
    expect(resolveNotaryUrl(PUBLISHED, null)).toBe(PUBLISHED);
    // …and with no publish reaches the core's own default, which is the only route to the no-op prover.
    expect(resolveNotaryUrl(undefined, null)).toBeUndefined();
  });

  it('production compiles in the production notary', () => {
    // The dev arm is behind `import.meta.env.DEV`, and vitest runs with DEV true and this repo's real
    // .env loaded — so assert what is invariant either way: the fallback is production's notary, and the
    // literal is pinned here because it is a deployed endpoint (a typo in it ships a build whose every
    // proof dies in the field).
    expect(PROD_NOTARY_URL).toBe('wss://api.dmarket.com/provenance/v1/');
    expect(resolveNotaryUrl(undefined, undefined)).toBe(import.meta.env.WXT_DEV_NOTARY_URL || PROD_NOTARY_URL);
  });

  it('agrees with the installed core, which defaults the same field to the same notary', () => {
    // The one assertion that makes keeping our own copy of this URL safe. The core needs its own default
    // (a host that configures nothing must still attest through a real notary) and we need ours (the debug
    // console reports the notary the tracker was started with, and would otherwise say "noop" over an
    // armed core) — so the string exists in two repos and nothing else checks that they match:
    // `check-core-params` compares parameter names and arity, not values, and once both copies are in the
    // bundle the grep in scripts/verify-build.mjs cannot tell them apart.
    //
    // Against the real installed package, like the rest of src/core/config.test.ts: a core bump that moves
    // the notary fails here rather than in the field.
    //
    // The constant, not `new NotaryConfig().notaryUrl` — that the core's FIELD default is sourced from its
    // own constant is the core's assertion to make (`TrackerConfigTest` makes it), and re-making it here
    // would be the same fact owned in two repos, which is the problem this test exists to solve.
    expect(PROD_NOTARY_URL).toBe(NotaryConfig.Companion.PRODUCTION_NOTARY_URL);
  });
});
