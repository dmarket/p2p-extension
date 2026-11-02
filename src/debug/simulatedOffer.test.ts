import { parseHTML } from 'linkedom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readVerdicts, recordSuspiciousOffers } from '@/background/offerGuard';
import type { SimulatedOffer } from '@/debug/protocol';
import { simulatedOfferFrame } from '@/debug/simulatedOffer';
import { syncStandIns } from '@/ui/steam/useOfferWarnings';

const offer = (o: Partial<SimulatedOffer> = {}): SimulatedOffer => ({
  level: 'IMPERSONATION',
  direction: 'received',
  offerId: '9000000001',
  partnerSteamId: '76561198000000077',
  personaName: 'DM Bot',
  giveCount: 2,
  ...o,
});

describe('a simulated suspicious offer', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reaches the cache with its direction, as the core frame would', async () => {
    await recordSuspiciousOffers(simulatedOfferFrame(offer())!);
    await recordSuspiciousOffers(simulatedOfferFrame(offer({ offerId: '9000000002', direction: 'sent' }))!);
    const v = await readVerdicts();
    expect(v['9000000001']).toMatchObject({ direction: 'received', simulated: { personaName: 'DM Bot' } });
    expect(v['9000000002']?.direction).toBe('sent');
  });

  it('refuses a direction the core does not send', () => {
    expect(simulatedOfferFrame(offer({ direction: 'both' as never }))).toBeUndefined();
  });

  it('is drawn received-shaped, and redrawn when only its direction changes', () => {
    const { document } = parseHTML('<html><body><div class="maincontent"></div></body></html>');
    vi.stubGlobal('document', document);
    const v = { level: 'IMPERSONATION' as const, partnerSteamId: '76561198000000077', giveCount: 2, at: 1, simulated: { personaName: 'DM Bot' } };
    expect(syncStandIns({ '11': { ...v, direction: 'received' } })).toBe(true);
    const block = document.getElementById('tradeofferid_11')!;
    expect(block.querySelector('.tradeoffer_header')?.textContent).toMatch(/^DM Bot offered you a trade/);
    // The user's items on their own side, the sender's avatar on the side it gives (nothing) from.
    expect(block.querySelectorAll('.secondary .trade_item')).toHaveLength(2);
    expect(block.querySelector('.primary .tradeoffer_avatar')).not.toBeNull();
    expect(syncStandIns({ '11': { ...v, direction: 'received' } })).toBe(false);
    expect(syncStandIns({ '11': { ...v, direction: 'sent' } })).toBe(true);
    expect(document.getElementById('tradeofferid_11')?.querySelector('.tradeoffer_header')?.textContent).toMatch(/^You offered DM Bot/);
  });
});
