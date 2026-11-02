import { Fragment } from 'preact';
import { steamIcons } from './icons';
import { canTrust, offerCopy } from './offerCopy';
import type { OfferWarning } from './useOfferWarnings';

/** More than this many and the rest collapse into one line: a page of banners hides the list they are about. */
const MAX_BANNERS = 3;

/**
 * One suspicious offer, above the page's usual banner. Same shape and classes as MismatchBanner.
 * Yellow: the offer gives items away and no DMarket deal explains it; the user can say they know the partner of
 * an offer they sent. Red: the partner poses as DMarket or is a known scam account; there is nothing to dismiss,
 * it goes when the offer leaves the page.
 */
function OfferBanner({ w, onTrust, showLink }: { w: OfferWarning; onTrust: () => void; showLink: boolean }) {
  const danger = w.level === 'IMPERSONATION';
  const copy = offerCopy({ ...w.offer, level: w.level, direction: w.direction });
  return (
    <div class={`dmp banner banner--${danger ? 'danger' : 'warning'}`} role="alert">
      <div class={`icon-box ${danger ? 'icon-box--mismatch' : 'icon-box--warning'} banner__icon`}>
        <img src={steamIcons.glyphRun} alt="" />
      </div>
      <div class="banner__text">
        <div class="banner__title-row">
          <img class="banner__warning" src={steamIcons.warning} alt="" />
          <p class="banner__title banner__title--offer">{copy.title}</p>
        </div>
        <p class="banner__subtitle">
          {copy.body.map((part, i) =>
            typeof part === 'string' ? (
              <Fragment key={i}>{part}</Fragment>
            ) : (
              <span key={i} class="banner__subtitle-value">
                {part.value}
              </span>
            ),
          )}
        </p>
        {showLink && (
          <a class="banner__subtitle-link" href={`#tradeofferid_${w.offer.offerId}`}>
            Show offer #{w.offer.offerId}
          </a>
        )}
      </div>
      {/* No link to the deal: the DMarket site has no route to one offer. */}
      {canTrust({ ...w.offer, level: w.level, direction: w.direction }) && (
        <div class="banner__actions">
          <button class="button--ghost" type="button" onClick={onTrust}>
            I know this partner
          </button>
        </div>
      )}
    </div>
  );
}

/** While the core checks the offers: neutral, no level, and nothing after it (see checkingVisible). */
export function CheckingNotice({ single }: { single: boolean }) {
  return (
    <p class="dmp banner__subtitle banner__checking" role="status">
      {single
        ? "Checking this offer… Don't confirm it in Steam Mobile until this finishes."
        : "Checking your sent offers… Don't confirm them in Steam Mobile until this finishes."}
    </p>
  );
}

/** `onOfferPage`: the page is the offer itself, so there is no block to link to. */
export function SuspiciousOfferBanners({
  warnings,
  onTrust,
  onOfferPage = false,
}: {
  warnings: OfferWarning[];
  onTrust: (steamId: string) => void;
  onOfferPage?: boolean;
}) {
  if (warnings.length === 0) return null;
  const rest = warnings.slice(MAX_BANNERS);
  return (
    <>
      {warnings.slice(0, MAX_BANNERS).map((w) => (
        <OfferBanner
          key={w.offer.offerId}
          w={w}
          showLink={!onOfferPage}
          onTrust={() => w.offer.partnerSteamId !== undefined && onTrust(w.offer.partnerSteamId)}
        />
      ))}
      {/* The rest by name, each a link to its block: without inline marks on the list, a bare count would
          leave the user no way to tell which offers it means. Same order as the banners, red first. */}
      {rest.length > 0 && (
        <p class="dmp banner__more">
          {rest.length} more suspicious {rest.length === 1 ? 'offer' : 'offers'}:{' '}
          {rest.map((w, i) => (
            <Fragment key={w.offer.offerId}>
              {i > 0 && ', '}
              <a
                class={`banner__more-link banner__more-link--${w.level === 'IMPERSONATION' ? 'danger' : 'warning'}`}
                href={`#tradeofferid_${w.offer.offerId}`}
              >
                {w.offer.personaName || 'unknown partner'} (#{w.offer.offerId})
              </a>
            </Fragment>
          ))}
        </p>
      )}
    </>
  );
}
