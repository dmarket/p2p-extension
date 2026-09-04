import { steamIcons } from './icons';

interface BannerProps {
  onActivate: () => void;
}

/** Top-of-page banner inviting the user to activate trade tracking. Shown until activated. */
export function Banner({ onActivate }: BannerProps) {
  return (
    <div class="dmp banner">
      <div class="icon-box banner__icon">
        <img src={steamIcons.glyphRun} alt="" />
      </div>
      <div class="banner__text">
        <p class="banner__title">Activate DMarket trade tracking</p>
        <p class="banner__subtitle">
          Allow the extension to monitor your trade offers to verify P2P trades on DMarket.
        </p>
      </div>
      <button type="button" class="button--accent" onClick={onActivate}>
        Activate
      </button>
    </div>
  );
}
