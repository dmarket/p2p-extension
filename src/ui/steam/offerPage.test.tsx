import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEAM_INTEGRATION } from '@/config/steam';
import type { OfferVerdict } from '@/state/offerGuard';
import {
  CHECK_FRESH_MS,
  CHECK_TIMEOUT_MS,
  checkingVisible,
  isLandingPage,
  landingRequest,
  landingWarnings,
  offerBlockIds,
  offerPageId,
  offerPageRequest,
  offerPageWarning,
} from './offerPage';
import { CheckingNotice, SuspiciousOfferBanners } from './SuspiciousOfferBanner';

const SCAM = '76561198781084366';
const verdict = (v: Partial<OfferVerdict> = {}): OfferVerdict => ({
  level: 'UNLINKED_GIVE_ONLY',
  direction: 'sent',
  partnerSteamId: '76561198000000077',
  giveCount: 3,
  at: 1,
  ...v,
});

describe('the offer page URL', () => {
  it('gives the offer id of /tradeoffer/<id>/ and nothing for any other page', () => {
    expect(offerPageId('/tradeoffer/9000000001/')).toBe('9000000001');
    expect(offerPageId('/tradeoffer/9000000001')).toBe('9000000001');
    expect(offerPageId('/tradeoffer/new/')).toBeUndefined();
    expect(offerPageId('/id/me/tradeoffers/sent/')).toBeUndefined();
    expect(offerPageId('/tradeoffer/12ab/')).toBeUndefined();
  });

  it('is in the content script patterns', () => {
    expect(STEAM_INTEGRATION.tradeOffersMatchPatterns).toContain('https://steamcommunity.com/tradeoffer/*');
  });
});

describe('the offer page anchor', () => {
  const fixture = readFileSync(new URL('./__fixtures__/trade-offer.html', import.meta.url), 'utf8');
  const { document } = parseHTML(`<html><body>${fixture}</body></html>`);

  it('exists on Steam trade window, which has no .maincontent for the list page anchor', () => {
    expect(document.querySelector(STEAM_INTEGRATION.offerPageAnchorSelector)?.querySelector('.trade_area')).toBeTruthy();
    expect(document.querySelector(STEAM_INTEGRATION.bannerAnchorSelector)).toBeNull();
  });
});

describe('the offer page request and banner', () => {
  it('asks about this offer only, never as a complete page', () => {
    expect(offerPageRequest('9000000001')).toEqual({ kind: 'offer-verdicts', offerIds: ['9000000001'], pageComplete: false });
  });

  it('builds the banner from the verdict, with the core name and item count', () => {
    expect(offerPageWarning('9000000001', verdict({ personaName: 'Felix' }), [])).toEqual({
      offer: { offerId: '9000000001', partnerSteamId: '76561198000000077', personaName: 'Felix', giveCount: 3, receiveCount: 0 },
      level: 'UNLINKED_GIVE_ONLY',
      direction: 'sent',
    });
  });

  it('takes a simulated name when the verdict has no core one, and raises a known scam partner', () => {
    const w = offerPageWarning('1', verdict({ partnerSteamId: SCAM, simulated: { personaName: 'Sim' } }), [SCAM]);
    expect(w).toMatchObject({ level: 'IMPERSONATION', offer: { personaName: 'Sim' } });
  });

  it('has no banner for an offer with no verdict', () => {
    expect(offerPageWarning('9000000001', undefined, [SCAM])).toBeUndefined();
  });
});

describe('rendering on the offer page', () => {
  const { document } = parseHTML('<html><body><div id="root"></div></body></html>');
  afterEach(() => vi.unstubAllGlobals());

  const draw = (node: preact.ComponentChild): string => {
    vi.stubGlobal('document', document);
    const root = document.getElementById('root')!;
    render(node, root);
    return root.textContent ?? '';
  };

  it('names the partner from the verdict and has no link to a list block', () => {
    const w = offerPageWarning('9000000001', verdict({ personaName: 'Felix' }), [])!;
    const text = draw(<SuspiciousOfferBanners warnings={[w]} onTrust={() => {}} onOfferPage />);
    expect(text).toContain('Felix');
    expect(text).toContain('3 items');
    expect(text).not.toContain('Show offer');
  });

  it('shows the received copy for an offer sent to the user, with nothing to dismiss', () => {
    const w = offerPageWarning('9000000001', verdict({ level: 'IMPERSONATION', direction: 'received', partnerSteamId: SCAM }), [])!;
    const text = draw(<SuspiciousOfferBanners warnings={[w]} onTrust={() => {}} onOfferPage />);
    expect(text).toContain(`${SCAM} is a known scam account. DMarket bots only send you an offer`);
    expect(text).not.toContain('I know this partner');
  });

  it('renders nothing for an unflagged offer', () => {
    expect(draw(<SuspiciousOfferBanners warnings={[]} onTrust={() => {}} onOfferPage />)).toBe('');
  });

  it('shows the checking notice for this offer', () => {
    expect(draw(<CheckingNotice single />)).toContain("Checking this offer… Don't confirm it in Steam Mobile");
  });
});

describe('the trade-offers landing page', () => {
  const html = (ids: string[]) =>
    parseHTML(
      `<html><body>${ids.map((id) => `<div class="tradeoffer" id="tradeofferid_${id}"></div>`).join('')}<div class="tradeoffer" id="other"></div></body></html>`,
    ).document;

  it('is the landing page only, not the sent list or the history', () => {
    expect(isLandingPage('/id/me/tradeoffers/', '')).toBe(true);
    expect(isLandingPage('/profiles/76561198000000077/tradeoffers', '')).toBe(true);
    expect(isLandingPage('/id/me/tradeoffers/sent/', '')).toBe(false);
    expect(isLandingPage('/id/me/tradeoffers/', '?history=1')).toBe(false);
  });

  it('takes only the offer block ids and reports nothing it recognised itself', () => {
    const ids = offerBlockIds(html(['11', '12']), { offer: '.tradeoffer' });
    expect(ids).toEqual(['11', '12']);
    expect(landingRequest(ids)).toEqual({ kind: 'offer-verdicts', offerIds: ['11', '12'], pageComplete: false });
  });

  it('warns about the received verdicts among its offers only', () => {
    const verdicts = {
      '11': verdict({ level: 'IMPERSONATION', direction: 'received', partnerSteamId: SCAM }),
      '12': verdict({ direction: 'sent' }),
      '13': verdict({ level: 'IMPERSONATION', direction: 'received' }),
    };
    const warnings = landingWarnings(['11', '12'], verdicts, []);
    expect(warnings.map((w) => [w.offer.offerId, w.direction, w.level])).toEqual([['11', 'received', 'IMPERSONATION']]);
  });
});

describe('the checking notice', () => {
  const openedAt = 1_000_000;
  const base = { coreRunning: true, openedAt, now: openedAt + 1000 };

  it('shows until a check newer than the page opening arrives', () => {
    expect(checkingVisible({ ...base, scannedAt: null })).toBe(true);
    expect(checkingVisible({ ...base, scannedAt: openedAt - CHECK_FRESH_MS - 1 })).toBe(true);
    expect(checkingVisible({ ...base, scannedAt: openedAt + 500 })).toBe(false);
  });

  it('does not show for a check of the last 30 s, which the core would not repeat', () => {
    expect(checkingVisible({ ...base, scannedAt: openedAt - CHECK_FRESH_MS + 1 })).toBe(false);
  });

  it('does not show when the core is not running', () => {
    expect(checkingVisible({ ...base, coreRunning: false, scannedAt: null })).toBe(false);
  });

  it('goes after the timeout even with no new check', () => {
    expect(checkingVisible({ ...base, now: openedAt + CHECK_TIMEOUT_MS - 1, scannedAt: null })).toBe(true);
    expect(checkingVisible({ ...base, now: openedAt + CHECK_TIMEOUT_MS, scannedAt: null })).toBe(false);
  });
});
