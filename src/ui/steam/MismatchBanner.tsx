import { getSettings } from '@/config/settings';
import { useLinkedSteamId } from '@/ui/hooks/useLinkedSteamId';
import { steamIcons } from './icons';

// Sign out via a native `javascript:` anchor — the same mechanism Steam's own account menu uses
// (`<a href="javascript:Logout();">`). The browser evaluates the href in the page's main world on a
// real user click, so the page global `Logout()` resolves directly — no content-script injection.
// The expression is remote-config-tunable so a Steam-side rename is a config fix (no redeploy); read at
// render (the content script loads the settings snapshot before mounting).

/**
 * Persistent banner shown when the browser is signed into a Steam account other than the one linked to
 * the DMarket profile. All Steam activity is blocked by the core until the accounts agree; the button
 * signs the user out of Steam.
 */
export function MismatchBanner() {
  const logoutHref = `javascript:${getSettings().web.logoutExpression}`;
  // Naming the account is what makes this prompt actionable — the user is standing on a Steam page and can
  // compare it against the profile they are signed into. Absent on an older core / before this episode's
  // first mismatched heartbeat, in which case the generic copy stands unchanged.
  const linkedSteamId = useLinkedSteamId();
  return (
    <div class="dmp banner">
      <div class="icon-box icon-box--mismatch banner__icon">
        <img src={steamIcons.glyphRun} alt="" />
      </div>
      <div class="banner__text">
        <div class="banner__title-row">
          <img class="banner__warning" src={steamIcons.warning} alt="" />
          <p class="banner__title">Wrong Steam account</p>
        </div>
        <p class="banner__subtitle">
          Log in to Steam with the account linked to DMarket
          {linkedSteamId !== undefined && (
            <>
              {' — '}
              <span class="banner__subtitle-value">{linkedSteamId}</span>
            </>
          )}
        </p>
      </div>
      {/* Intentional `javascript:` href, mirroring Steam's own native logout link. (This carried a bare
          `eslint-disable-next-line` with no rule named — i.e. it silenced EVERY rule on the line below.
          Now that ESLint actually runs, the blanket form is a permanent blind spot; no configured rule
          objects to this line, so the directive is gone and the reason stays.) */}
      <a class="button--light" href={logoutHref} role="button">
        Switch account
      </a>
    </div>
  );
}
