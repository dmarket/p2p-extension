import { getSettings } from '@/config/settings';
import { steamIcons } from './icons';

/**
 * Persistent banner shown on the Steam trade-offers page once tracking is activated and the Steam
 * account matches the DMarket-linked one. Purely informational — no action.
 */
export function ActiveBanner() {
  const link = getSettings().web.activeBannerLink;
  return (
    <div class="dmp banner">
      <div class="icon-box icon-box--ok banner__icon">
        <img src={steamIcons.glyphRun} alt="" />
      </div>
      <div class="banner__text">
        <p class="banner__title banner__title--on">
          Trade tracking is <span class="banner__title-accent">ON</span>
        </p>
        <p class="banner__subtitle">
          Keep trading from{' '}
          <a class="banner__subtitle-link" href={link} target="_blank" rel="noreferrer">
            dmarket.com
          </a>
        </p>
      </div>
    </div>
  );
}
