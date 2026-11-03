import { describe, expect, it } from 'vitest';
import { canTrust, offerCopy, type CopyPart } from './offerCopy';

const SCAM = '76561198781084366';
const text = (parts: CopyPart[]): string => parts.map((p) => (typeof p === 'string' ? p : p.value)).join('');

describe('offerCopy', () => {
  it('tells the user to decline a received offer from a known scam account, naming it by steamid without a name', () => {
    const copy = offerCopy({ level: 'IMPERSONATION', direction: 'received', partnerSteamId: SCAM, giveCount: 2 });
    expect(text(copy.body)).toBe(
      `${SCAM} is a known scam account. DMarket bots only send you an offer for a deposit you started on dmarket.com — decline it, don't accept or confirm it in Steam Mobile.`,
    );
    expect(copy.partner).toBe(`From ${SCAM}`);
    expect(copy.advice).toBe("Decline it, don't accept or confirm it in Steam Mobile.");
  });

  it('says a sender flagged on its name poses as a DMarket bot, and keeps the known-scam copy otherwise', () => {
    const copy = offerCopy({ level: 'IMPERSONATION', direction: 'received', personaName: 'DM Bot', partnerSteamId: SCAM, giveCount: 1, byName: true });
    expect(text(copy.body)).toBe(
      "DM Bot poses as a DMarket bot. DMarket bots only send you an offer for a deposit you started on dmarket.com — decline it, don't accept or confirm it in Steam Mobile.",
    );
    expect(copy.title).toBe('An account posing as a DMarket bot sent you a Steam offer');
    expect(copy.partner).toBe('From DM Bot');
    const scam = offerCopy({ level: 'IMPERSONATION', direction: 'received', personaName: 'DM Bot', partnerSteamId: SCAM, giveCount: 1 });
    expect(scam.title).toBe('A known scam account sent you a Steam offer');
  });

  it('prefers the persona name for a received offer, set apart as a value', () => {
    const copy = offerCopy({ level: 'IMPERSONATION', direction: 'received', personaName: 'DM Bot', partnerSteamId: SCAM, giveCount: 1 });
    expect(copy.body[0]).toEqual({ value: 'DM Bot' });
    expect(copy.partner).toBe('From DM Bot');
  });

  it('keeps the sent copy: the partner the offer goes to, and its steamid apart', () => {
    const red = offerCopy({ level: 'IMPERSONATION', direction: 'sent', personaName: 'D market', partnerSteamId: SCAM, giveCount: 1 });
    expect(text(red.body)).toBe(`The offer to D market (${SCAM}) looks like a scam. Don't confirm it in Steam Mobile.`);
    expect(red.partner).toBe('To D market');
    const yellow = offerCopy({ level: 'UNLINKED_GIVE_ONLY', direction: 'sent', partnerSteamId: SCAM, giveCount: 3 });
    expect(text(yellow.body)).toMatch(/^You give 3 items to this partner and get nothing back\./);
    expect(yellow.partner).toBe(`To ${SCAM}`);
  });
});

describe('canTrust', () => {
  it('lets the user dismiss only a yellow offer they sent to a known steamid', () => {
    expect(canTrust({ level: 'UNLINKED_GIVE_ONLY', direction: 'sent', partnerSteamId: SCAM })).toBe(true);
    expect(canTrust({ level: 'UNLINKED_GIVE_ONLY', direction: 'received', partnerSteamId: SCAM })).toBe(false);
    expect(canTrust({ level: 'IMPERSONATION', direction: 'received', partnerSteamId: SCAM })).toBe(false);
    expect(canTrust({ level: 'IMPERSONATION', direction: 'sent', partnerSteamId: SCAM })).toBe(false);
    expect(canTrust({ level: 'UNLINKED_GIVE_ONLY', direction: 'sent', partnerSteamId: undefined })).toBe(false);
  });
});
