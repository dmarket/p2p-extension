import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { STEAM_INTEGRATION } from '@/config/steam';
import { isKnownScamPartner, offerSelectorCoversPage, pageLevel, scanSentOffers, type PageOffer } from './offerScan';

const SCAM = '76561198781084366';
const fixture = readFileSync(new URL('./__fixtures__/sent-offers.html', import.meta.url), 'utf8');
const scan = () => scanSentOffers(parseHTML(`<html><body>${fixture}</body></html>`).document, STEAM_INTEGRATION.offerSelectors);

const offer = (o: Partial<PageOffer>): PageOffer => ({
  offerId: '1',
  partnerSteamId: '76561198000000009',
  personaName: 'someone',
  giveCount: 1,
  receiveCount: 0,
  ...o,
});

describe('scanSentOffers on the sent-offers page', () => {
  it('reads every offer block with its partner, name and both sides', () => {
    expect(scan()).toEqual([
      { offerId: '1000000001', partnerSteamId: '76561198000000003', personaName: 'trade_partner', giveCount: 2, receiveCount: 2 },
      { offerId: '1000000002', partnerSteamId: '76561198000000002', personaName: 'gift_bot', giveCount: 1, receiveCount: 0 },
      { offerId: '1000000003', partnerSteamId: SCAM, personaName: 'D mаrket', giveCount: 1, receiveCount: 0 },
    ]);
  });

  it('skips a closed offer: Steam still lists it, but it has no footer actions and cannot be confirmed', () => {
    expect(scan().map((o) => o.offerId)).not.toContain('1000000004');
    const doc = parseHTML(`<html><body>${fixture}</body></html>`).document;
    expect(doc.getElementById('tradeofferid_1000000004')).not.toBeNull();
  });

  it('takes the partner from the receiving side, never the page owner on the giving side', () => {
    expect(scan().map((o) => o.partnerSteamId)).not.toContain('76561198000000001');
  });

  it('leaves the partner unknown when the selector finds nothing, instead of guessing', () => {
    const doc = parseHTML(`<html><body>${fixture}</body></html>`).document;
    const offers = scanSentOffers(doc, { ...STEAM_INTEGRATION.offerSelectors, partner: '.no-such-thing' });
    expect(offers.every((o) => o.partnerSteamId === undefined)).toBe(true);
  });

  it('skips a block whose id is not a numeric offer id', () => {
    const { document } = parseHTML('<html><body><div class="tradeoffer" id="tradeofferid_x1"></div></body></html>');
    expect(scanSentOffers(document, STEAM_INTEGRATION.offerSelectors)).toEqual([]);
  });

  it('flags the fixture offers the way the page will show them', () => {
    const levels = scan().map((o) => pageLevel(o, o.offerId === '1000000002' ? 'UNLINKED_GIVE_ONLY' : undefined, [SCAM]));
    expect(levels).toEqual([undefined, 'UNLINKED_GIVE_ONLY', 'IMPERSONATION']);
  });
});

describe('offerSelectorCoversPage', () => {
  const page = () => parseHTML(`<html><body>${fixture}</body></html>`).document;
  const covers = (offer: string, doc = page()) => offerSelectorCoversPage(doc, { ...STEAM_INTEGRATION.offerSelectors, offer });

  it('holds with the default selector, closed blocks included', () => {
    expect(covers(STEAM_INTEGRATION.offerSelectors.offer)).toBe(true);
  });

  it('fails for a selector that matches nothing, so the empty scan cannot prune (DMA-859)', () => {
    expect(covers('div.qa-nope')).toBe(false);
  });

  it('fails for a selector that misses some blocks', () => {
    expect(covers('#tradeofferid_1000000001')).toBe(false);
  });

  it('holds on a page with no offers: the user really has none open, so stale warnings may go', () => {
    expect(covers('div.qa-nope', parseHTML('<html><body><div class="profile_leftcol"></div></body></html>').document)).toBe(true);
  });
});

describe('pageLevel', () => {
  it('raises any verdict to an impersonation for a known scam account, and never lowers one', () => {
    expect(pageLevel(offer({ partnerSteamId: SCAM }), 'UNLINKED_GIVE_ONLY', [SCAM])).toBe('IMPERSONATION');
    expect(pageLevel(offer({ partnerSteamId: SCAM }), undefined, [SCAM])).toBe('IMPERSONATION');
    expect(pageLevel(offer({}), 'IMPERSONATION', [SCAM])).toBe('IMPERSONATION');
    expect(pageLevel(offer({}), undefined, [SCAM])).toBeUndefined();
  });

  it('leaves a DMarket-like name to the core: the page does not judge names', () => {
    expect(isKnownScamPartner(offer({ personaName: 'D market' }), [SCAM])).toBe(false);
    expect(pageLevel(offer({ personaName: 'D market' }), undefined, [SCAM])).toBeUndefined();
  });
});
