import { getSettings } from '@/config/settings';
import type { OfferVerdict, OfferVerdicts } from '@/state/offerGuard';
import { offerCopy } from '@/ui/steam/offerCopy';

/** The sent list, or the landing page, which lists the offers sent to the user. */
function openOffers(page: 'sent' | 'received'): void {
  const base = getSettings().web.tradeOffersUrl.replace(/\/$/, '');
  void browser.tabs.create({ url: page === 'sent' ? `${base}/sent/` : `${base}/` });
}

/**
 * Title and text of the popup line for the cached verdicts, the most severe first, and which list shows them: the
 * received one when any is received, since its warning is red. `undefined` when there are none.
 */
export function describeFlagged(
  entries: readonly OfferVerdict[],
): { danger: boolean; title: string; text: string; page: 'sent' | 'received' } | undefined {
  const red = entries.filter((v) => v.level === 'IMPERSONATION').length;
  const yellow = entries.length - red;
  if (entries.length === 0) return undefined;
  const page = entries.some((v) => v.direction === 'received') ? 'received' : 'sent';
  if (entries.length === 1) {
    const only = entries[0]!;
    const copy = offerCopy(only);
    return {
      danger: red === 1,
      title:
        only.direction === 'received'
          ? copy.title
          : red === 1
            ? 'Suspicious Steam offer: the partner poses as DMarket'
            : "A Steam offer isn't linked to a DMarket deal",
      text: `${copy.partner}. ${copy.advice}`,
      page,
    };
  }
  // A received red offer comes from a known scam account (offerCopy) unless it was flagged on the sender's name.
  const scam = entries.filter((v) => v.level === 'IMPERSONATION' && v.direction === 'received' && !v.byName).length;
  const poses = red - scam;
  const parts = [
    poses > 0 && `${poses} ${poses === 1 ? 'poses' : 'pose'} as DMarket`,
    scam > 0 && `${scam} ${scam === 1 ? 'is' : 'are'} from a known scam account`,
    yellow > 0 && `${yellow} ${yellow === 1 ? "isn't" : "aren't"} linked to a DMarket deal`,
  ].filter(Boolean);
  const advice =
    page === 'received'
      ? "Decline offers you didn't expect; don't accept or confirm them in Steam Mobile."
      : "Don't confirm them in Steam Mobile unless you created them yourself.";
  return {
    danger: red > 0,
    title: `${entries.length} suspicious Steam offers`,
    text: `${parts.join(', ')}. ${advice}`,
    page,
  };
}

/**
 * The warning in the top band of the home screen while suspicious Steam offers are cached: the toolbar icon says
 * something is wrong, this says what, and the link opens the page that shows which offers. A single offer is named
 * by the partner's persona name from the core (its Steam id with an older core), several by how many of each kind.
 * Where it sits is popup.css's business (`--offer-slot`), so the home screen under it does not move when it appears.
 */
export function SuspiciousOffersRow({ verdicts }: { verdicts: OfferVerdicts }) {
  const flagged = describeFlagged(Object.values(verdicts));
  if (flagged === undefined) return null;
  return (
    <div class={`offer-alert offer-alert--${flagged.danger ? 'danger' : 'warning'}`} role="alert">
      <p class="offer-alert__title">{flagged.title}</p>
      <p class="offer-alert__text">
        {flagged.text}{' '}
        <button type="button" class="link offer-alert__action" onClick={() => openOffers(flagged.page)}>
          Open in Steam
        </button>
      </p>
    </div>
  );
}
