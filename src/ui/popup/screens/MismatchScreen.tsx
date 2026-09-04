import { getSettings } from '@/config/settings';
import { useLinkedSteamId } from '@/ui/hooks/useLinkedSteamId';
import { icons } from '../icons';

// Same binding as InactiveScreen's footer button: open the Steam trade-offers page (where the on-page
// banner lets the user switch/sign back into the DMarket-linked account). URL is remote-config-tunable.
function openTradeOffers(): void {
  void browser.tabs.create({ url: getSettings().web.tradeOffersUrl });
}

/**
 * Shown when the browser is signed into a Steam account other than the DMarket-linked one. All Steam
 * activity is blocked by the core until the accounts agree. Shown before onboarding too (see
 * state/surface.ts): activating on the wrong account would track nothing.
 */
export function MismatchScreen() {
  // The account the user has to sign into. Absent on an older core, or before the first mismatched
  // heartbeat of this episode — the copy stands on its own without it, so it is only ever an addition.
  const linkedSteamId = useLinkedSteamId();
  return (
    <div class="home">
      <div class="app-icon">
        <div class="app-icon__box app-icon__box--mismatch">
          <img class="app-icon__glyph" src={icons.glyphRunMismatch} alt="" />
        </div>
        <img class="app-icon__badge" src={icons.badgeError} alt="" />
      </div>

      <div class="home__body">
        <h1 class="title">
          <img class="title__flag" src={icons.flag} alt="" />
          <span>Tracking disabled</span>
        </h1>
        <p class="body-text">
          We noticed you're logged into a different Steam account. The extension needs to monitor
          trade offers for the account you originally connected. Log back into that account to
          continue using P2P trading.
        </p>
        {/* Naming the account turns an un-actionable prompt into a fixable one — and it is how a user can
            tell "my session is on the wrong account" from "my DMarket profile is linked to an account I do
            not use". It is their own linked id; whoever else is signed into the browser is never shown. */}
        {linkedSteamId !== undefined && (
          <p class="body-note">
            Linked Steam ID: <span class="body-note__value">{linkedSteamId}</span>
          </p>
        )}
      </div>

      <button type="button" class="button" onClick={openTradeOffers}>
        <span>Turn on tracker</span>
        <img class="button__icon" src={icons.arrowForward} alt="" />
      </button>
    </div>
  );
}
