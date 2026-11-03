// "Simulate suspicious offer": makes the suspicious-offer guard warn about a Steam offer, sent or received, without
// any trade being created. The worker feeds a `SuspiciousOutgoingOffers` frame to the core's own lifecycle callback
// (src/debug/router.ts), so the badge, the popup row and the banner on steamcommunity.com/my/tradeoffers/sent/ (or
// /tradeoffers/ for a received one) all take the real path. An offer id Steam does not list gets a stand-in block
// on that page.
//
// Pinned beside the storage rows like the freshness-mark injector, and showing its answer the same way: the
// cached verdicts live in `storage.session`, which the storage list (local only) does not show.

import { useState } from 'preact/hooks';
import type { SimulatedOffer } from '@/debug/protocol';
import {
  GUARD_VERDICTS_KEY,
  OFFER_LEVELS,
  type OfferDirection,
  type OfferLevel,
} from '@/state/offerGuard';
import { useVerdicts } from '@/ui/hooks/useVerdicts';
import { sendDebug } from '@/ui/debug/messaging';
import { getSettings } from '@/config/settings';
import { isKnownScamPartner } from '@/ui/steam/offerScan';

// The yellow case: an account on no list. A simulation is sent as the core would send it, so the level you pick
// is the level shown; only a partner in `web.knownScamPartners` raises it, as on the real page. The core's own
// name check does not run here: pick IMPERSONATION to see what it produces.
const INITIAL: SimulatedOffer = {
  level: 'UNLINKED_GIVE_ONLY',
  direction: 'sent',
  offerId: '9000000001',
  partnerSteamId: '76561198000000077',
  personaName: 'Felix',
  giveCount: 1,
};

/** The colour the page will show for [o], and why: the same rule the page applies. */
function expectedColour(o: SimulatedOffer): string {
  if (isKnownScamPartner(o, getSettings().web.knownScamPartners ?? [])) return 'red: the partner is in web.knownScamPartners';
  return o.level === 'IMPERSONATION' ? 'red: level IMPERSONATION' : 'yellow';
}

export function SuspiciousOfferPanel(): preact.JSX.Element {
  const [draft, setDraft] = useState<SimulatedOffer>(INITIAL);
  const cached = useVerdicts() ?? {};
  const [note, setNote] = useState('');

  const send = (offer: SimulatedOffer | null) =>
    void sendDebug({ type: 'debug:simulate-offer', offer }).then((r) =>
      setNote('ok' in r && r.ok === false && 'error' in r ? String(r.error) : offer === null ? 'cleared' : 'sent'),
    );

  const text = (key: 'offerId' | 'partnerSteamId' | 'personaName', label: string) => (
    <label class="muted demand-field">
      {label}
      <input
        type="text"
        value={draft[key]}
        onInput={(e) => setDraft({ ...draft, [key]: (e.target as HTMLInputElement).value.trim() })}
      />
    </label>
  );

  const count = Object.keys(cached).length;
  return (
    <details class="store-row">
      <summary>
        <span class="store-key">{GUARD_VERDICTS_KEY}</span>
        <span class={`pill ${count > 0 ? 'on' : ''}`}>{count > 0 ? `${count} flagged` : 'none'}</span>
        <span class="muted">simulate suspicious offer</span>
      </summary>
      <div class="store-body">
        <div class="demand-body">
          <label class="muted demand-field">
            level
            <select
              value={draft.level}
              onChange={(e) => setDraft({ ...draft, level: (e.target as HTMLSelectElement).value as OfferLevel })}
            >
              {OFFER_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label class="muted demand-field">
            direction
            <select
              value={draft.direction}
              onChange={(e) => setDraft({ ...draft, direction: (e.target as HTMLSelectElement).value as OfferDirection })}
            >
              <option value="sent">sent (/tradeoffers/sent/)</option>
              <option value="received">received (/tradeoffers/)</option>
            </select>
          </label>
          {text('offerId', 'offer id (an existing one, or any digits for a stand-in block)')}
          {text('partnerSteamId', 'partner steamid64')}
          {text('personaName', 'persona name (as the core would send it)')}
          <label class="muted demand-field">
            give count
            <input
              type="number"
              min={1}
              max={50}
              value={draft.giveCount}
              onInput={(e) => setDraft({ ...draft, giveCount: Number((e.target as HTMLInputElement).value) })}
            />
          </label>
          <p class="muted">
            the {draft.direction === 'received' ? 'landing' : 'sent'} page will show: {expectedColour(draft)}
          </p>
          <div>
            <button onClick={() => send(draft)}>simulate suspicious offer</button>{' '}
            <button onClick={() => send(null)}>clear simulated</button> <span class="muted">{note}</span>
          </div>
          <p class="muted">
            Then open steamcommunity.com/my/tradeoffers/sent/, or /tradeoffers/ for a received offer. The page shows the level sent here, raised to
            IMPERSONATION only for a partner in web.knownScamPartners. Session storage: a browser restart forgets
            every verdict.
          </p>
          <pre>{JSON.stringify(cached, null, 2)}</pre>
        </div>
      </div>
    </details>
  );
}
