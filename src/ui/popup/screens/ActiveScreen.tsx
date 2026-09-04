import { icons } from '../icons';
import { useActiveTrackingCount } from '@/ui/hooks/useActiveTrackingCount';

/** Shown when tracking is activated. */
export function ActiveScreen() {
  const count = useActiveTrackingCount();

  return (
    <div class="home">
      {/* "Activity on DMarket" pill (Figma 2006:1524) — the live number of trades the core is
          currently watching. Hidden entirely while nothing is tracked; caps at "99+". */}
      {count > 0 && (
        <div class="activity-badge">
          <img class="activity-badge__icon" src={icons.activity} alt="" />
          <span class="activity-badge__label">Activity on DMarket</span>
          <span class="activity-badge__count">{count > 99 ? '99+' : count}</span>
        </div>
      )}

      <div class="app-icon">
        <div class="app-icon__box app-icon__box--active">
          <img class="app-icon__glyph" src={icons.glyphRunActive} alt="" />
        </div>
        <span class="app-icon__badge app-icon__badge--check">
          <img src={icons.badgeCheck} alt="" />
        </span>
      </div>

      <div class="home__body">
        <h1 class="title">
          <span>
            Trade tracking is <span class="title__accent">ON</span>
          </span>
        </h1>
        <p class="body-text">
          The extension is monitoring your Steam trade offers. Your P2P trades will be verified
          automatically to make sure each offer matches the deal on DMarket.
        </p>
      </div>
    </div>
  );
}
