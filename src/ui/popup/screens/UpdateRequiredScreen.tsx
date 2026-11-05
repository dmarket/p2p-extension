import type { Ref } from 'preact';
import { icons } from '../icons';

/**
 * Shown when this build is below the published `web.minExtensionVersion` and Chrome did not hand over the
 * update by itself (`restart_required`). Trades already in progress keep being tracked; the FE and the
 * backend stop new ones, so this screen only tells the user what to do.
 *
 * `onHowToUpdate` renders the "How to update?" link; without it there is no link. `linkRef` lets the caller
 * return focus to it.
 */
export function UpdateRequiredScreen({
  onHowToUpdate,
  linkRef,
}: {
  onHowToUpdate?: () => void;
  linkRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div class="home">
      <div class="app-icon">
        <div class="app-icon__box app-icon__box--inactive">
          <img class="app-icon__glyph" src={icons.glyphRunInactive} alt="" />
        </div>
        <img class="app-icon__badge" src={icons.badgeUpdate} alt="" />
      </div>

      <div class="home__body">
        <h1 class="title">
          <img class="title__warning" src={icons.warning} alt="" />
          <span>Update required</span>
        </h1>
        <p class="body-text">Yours is out of date. Update it from the extensions page or restart your browser.</p>
        {onHowToUpdate && (
          <button type="button" class="update-link" ref={linkRef} onClick={onHowToUpdate}>
            How to update?
          </button>
        )}
      </div>
    </div>
  );
}
