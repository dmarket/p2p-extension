import { getSettings } from '@/config/settings';
import { icons } from '../icons';

function openTradeOffers(): void {
  void browser.tabs.create({ url: getSettings().web.tradeOffersUrl });
}

/** Shown when tracking is not yet activated. Points the user to the Steam trade-offers banner. */
export function InactiveScreen() {
  return (
    <div class="home">
      <div class="app-icon">
        <div class="app-icon__box app-icon__box--inactive">
          <img class="app-icon__glyph" src={icons.glyphRunInactive} alt="" />
        </div>
        <img class="app-icon__badge" src={icons.badgeCancel} alt="" />
      </div>

      <div class="home__body">
        <h1 class="title">
          <img class="title__warning" src={icons.warning} alt="" />
          <span>Activate trade tracking</span>
        </h1>
        <p class="body-text">
          To use P2P trading, the extension needs to monitor your Steam trade offers. Visit your{' '}
          <a class="link" onClick={openTradeOffers}>
            Steam Trade Offers
          </a>{' '}
          page and click "Activate" in the banner at the top.
        </p>
      </div>

      <button type="button" class="button" onClick={openTradeOffers}>
        <span>Turn on tracker</span>
        <img class="button__icon" src={icons.arrowForward} alt="" />
      </button>
    </div>
  );
}
