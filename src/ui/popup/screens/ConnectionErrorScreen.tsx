import { icons } from '../icons';

/**
 * Shown while activated but the last `/heartbeat` reached DMarket and failed with a non-401 error (a
 * deterministic 4xx like 404, or a persistent 5xx) — the core's `DM_CONNECTION_ERROR` state. Distinct from
 * {@link MissingConnectionScreen}: the DMarket session is fine, so this is NOT a "log back in" prompt —
 * DMarket itself is unreachable and there's nothing the user can do. The tracker keeps retrying and this
 * auto-clears the moment a later heartbeat succeeds (the banner is removed on `NONE`). The
 * LOWEST-priority state: every actionable sign-in prompt outranks it (see state/surface.ts). Also the
 * fail-closed surface for a reason this build does not recognise.
 */
export function ConnectionErrorScreen() {
  return (
    <div class="home">
      <div class="app-icon">
        <div class="app-icon__box app-icon__box--mismatch">
          <img class="app-icon__glyph app-icon__glyph--sad" src={icons.glyphSad} alt="" />
        </div>
      </div>

      <div class="home__body">
        <h1 class="title">
          <span>Can't reach DMarket right now</span>
        </h1>
        <p class="body-text">
          DMarket isn't responding as expected, so trade tracking is paused. You're still signed in —
          we'll keep retrying and resume automatically once the connection is back.
        </p>
      </div>
    </div>
  );
}
