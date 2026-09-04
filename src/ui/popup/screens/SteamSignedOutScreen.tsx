import { getSettings } from '@/config/settings';
import { icons } from '../icons';

// Open Steam's login page directly (not a deep link that merely redirects there): it is the page that
// runs Steam's persistent-login handshake, so a user Steam still remembers is signed straight back in,
// and its `goto` returns them to the trade-offers page where the on-page banner lives. URL is
// remote-config-tunable (web.steamLoginUrl) in case Steam moves the entry point.
function openSteam(): void {
  void browser.tabs.create({ url: getSettings().web.steamLoginUrl });
}

/**
 * Shown while activated but there is no usable Steam web session — the session cookie is gone or its
 * token has expired — so the core can't acquire a Steam credential and the cycle stops before the
 * heartbeat: the core's `STEAM_SESSION_MISSING` state. Outranked only by a missing DMarket session
 * (see state/surface.ts) — and shown before onboarding, since the Steam rules flow needs a Steam login.
 *
 * Distinct from {@link MismatchScreen} (signed into the *wrong* Steam account — that one keeps the
 * "Tracking disabled" title and the flag badge) and from the two DMarket screens. Auto-clears once the
 * core acquires a credential again — the extension's session-cookie watch nudges that the moment the
 * user signs in, so nothing depends on this button being pressed.
 */
export function SteamSignedOutScreen() {
  return (
    <div class="home">
      <div class="app-icon">
        <div class="app-icon__box app-icon__box--mismatch">
          <img class="app-icon__glyph app-icon__glyph--sad" src={icons.glyphSad} alt="" />
        </div>
        <img class="app-icon__badge" src={icons.badgeError} alt="" />
      </div>

      <div class="home__body">
        <h1 class="title">
          <span>Sign in to Steam to keep tracking</span>
        </h1>
        <p class="body-text">
          You're signed out of Steam, so we can't watch your trade offers. Sign back in and tracking
          resumes on its own.
        </p>
      </div>

      <button type="button" class="button" onClick={openSteam}>
        <span>Log in to Steam</span>
        <img class="button__icon" src={icons.arrowForward} alt="" />
      </button>
    </div>
  );
}
