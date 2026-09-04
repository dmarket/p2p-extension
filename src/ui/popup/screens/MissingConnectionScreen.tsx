import { resolveDmarketUrl } from '@/config/dmarketSite';
import { icons } from '../icons';

// Open the DMarket site so the user can sign back in and restore the DMarket session (re-issues the
// `dm-trade-token` the core reads). The next heartbeat clears the block on its own — see below.
// The URL is remote-config-tunable (web.dmarketUrl) and, in debug builds, follows the FE the tracker is
// actually running against (the debug console's endpoint) — signing in on the prod site would issue a
// cookie for an origin the core never reads, so the block would never clear. See config/dmarketSite.ts.
function openDmarket(): void {
  void resolveDmarketUrl().then((url) => browser.tabs.create({ url }));
}

/**
 * Shown when the tracker has no working DMarket connection (the `dm-trade-token` is missing/invalid and
 * could not be refreshed), so the heartbeat cannot pass. The HIGHEST-priority surface (see
 * state/surface.ts): it outranks every other block and onboarding itself, because nothing this extension
 * does works without a DMarket session. Auto-clears once a later heartbeat reconnects — the banner is
 * removed on `NONE`, not on the button click.
 */
export function MissingConnectionScreen() {
  return (
    <div class="home">
      <div class="app-icon">
        <div class="app-icon__box app-icon__box--mismatch">
          <img class="app-icon__glyph app-icon__glyph--sad" src={icons.glyphSad} alt="" />
        </div>
      </div>

      <div class="home__body">
        <h1 class="title">
          <span>Looks like we lost connection with DMarket</span>
        </h1>
        <p class="body-text">
          You may have been logged out. Check that you're signed in to DMarket, then try again.
        </p>
      </div>

      <button type="button" class="button" onClick={openDmarket}>
        <span>Check DMarket</span>
        <img class="button__icon" src={icons.arrowForward} alt="" />
      </button>
    </div>
  );
}
