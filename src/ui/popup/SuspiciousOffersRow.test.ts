import { describe, expect, it } from 'vitest';
import type { OfferVerdict } from '@/state/offerGuard';
import { describeFlagged } from './SuspiciousOffersRow';

const v = (level: OfferVerdict['level'], partnerSteamId = '76561198000000002', direction: OfferVerdict['direction'] = 'sent'): OfferVerdict => ({
  level,
  direction,
  partnerSteamId,
  giveCount: 1,
  at: 0,
});

describe('describeFlagged', () => {
  it('says nothing without verdicts', () => {
    expect(describeFlagged([])).toBeUndefined();
  });

  it('names the partner of a single offer', () => {
    expect(describeFlagged([v('UNLINKED_GIVE_ONLY')])).toMatchObject({
      danger: false,
      title: "A Steam offer isn't linked to a DMarket deal",
      text: expect.stringContaining('To 76561198000000002.') as string,
    });
  });

  it("names a single offer's partner by the core's persona name when there is one", () => {
    expect(describeFlagged([{ ...v('IMPERSONATION'), personaName: 'D market' }])?.text).toMatch(/^To D market\./);
  });

  it('counts several offers by kind and turns red if any is an impersonation', () => {
    expect(describeFlagged([v('UNLINKED_GIVE_ONLY'), v('IMPERSONATION'), v('UNLINKED_GIVE_ONLY')])).toEqual({
      danger: true,
      title: '3 suspicious Steam offers',
      text: "1 poses as DMarket, 2 aren't linked to a DMarket deal. Don't confirm them in Steam Mobile unless you created them yourself.",
      page: 'sent',
    });
  });

  it('stays yellow when none of several is an impersonation', () => {
    expect(describeFlagged([v('UNLINKED_GIVE_ONLY'), v('UNLINKED_GIVE_ONLY')])).toMatchObject({
      danger: false,
      text: expect.stringMatching(/^2 aren't linked/) as string,
    });
  });

  it('names the sender of a received offer and opens the landing page, which lists it', () => {
    expect(describeFlagged([v('IMPERSONATION', '76561198781084366', 'received')])).toEqual({
      danger: true,
      title: 'A known scam account sent you a Steam offer',
      text: "From 76561198781084366. Decline it, don't accept or confirm it in Steam Mobile.",
      page: 'received',
    });
  });

  it('counts a received red offer as a known scam account, and gives the advice for received offers', () => {
    expect(describeFlagged([v('UNLINKED_GIVE_ONLY'), v('IMPERSONATION', '76561198781084366', 'received')])).toEqual({
      danger: true,
      title: '2 suspicious Steam offers',
      text: "1 is from a known scam account, 1 isn't linked to a DMarket deal. Decline offers you didn't expect; don't accept or confirm them in Steam Mobile.",
      page: 'received',
    });
  });

  it('counts a received red offer flagged on the name as posing as DMarket, not as a known scam account', () => {
    const byName = { ...v('IMPERSONATION', '76561198000000003', 'received'), byName: true as const };
    expect(describeFlagged([byName, v('IMPERSONATION', '76561198781084366', 'received')])?.text).toMatch(
      /^1 poses as DMarket, 1 is from a known scam account\./,
    );
    expect(describeFlagged([{ ...byName, personaName: 'DM Bot' }])?.title).toBe(
      'An account posing as a DMarket bot sent you a Steam offer',
    );
  });

  it('opens the landing page when any of several is received', () => {
    expect(describeFlagged([v('UNLINKED_GIVE_ONLY'), v('IMPERSONATION', undefined, 'received')])?.page).toBe('received');
    expect(describeFlagged([v('UNLINKED_GIVE_ONLY'), v('IMPERSONATION')])?.page).toBe('sent');
  });
});
