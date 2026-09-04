import { describe, expect, it } from 'vitest';

import { type DemandInjection, isDemandArmed, NO_DEMAND, parseDemand } from '@/debug/demandState';

// The injector's parser and its "is this actually in effect" rule. Both fail SAFE, and the reason is the
// same one that makes the core's own mark handling fail safe: a half-written or hand-edited key must never
// leave a dev tool stamping something it cannot describe, because a mark the operator did not mean to arm is
// indistinguishable from one the backend sent.

const complete: DemandInjection = {
  enabled: true,
  dealId: 'deal-1',
  steamTradeId: '744935517744884653',
  proveAfter: '2026-09-02T10:15:30Z',
};

describe('parseDemand', () => {
  it('round-trips a complete value', () => {
    expect(parseDemand(complete)).toEqual(complete);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'enabled'],
    ['an array', []],
    ['a missing enabled flag', { dealId: 'd', steamTradeId: 't', proveAfter: 'p' }],
    ['a non-boolean enabled flag', { enabled: 'yes', dealId: 'd', steamTradeId: 't', proveAfter: 'p' }],
    ['a non-string deal id', { enabled: true, dealId: 7, steamTradeId: 't', proveAfter: 'p' }],
    ['a missing trade id', { enabled: true, dealId: 'd', proveAfter: 'p' }],
    ['a missing mark', { enabled: true, dealId: 'd', steamTradeId: 't' }],
  ])('falls back to disarmed for %s', (_label, raw) => {
    expect(parseDemand(raw)).toEqual(NO_DEMAND);
  });
});

describe('isDemandArmed', () => {
  it('is true only when armed and complete', () => {
    expect(isDemandArmed(complete)).toBe(true);
  });

  it('is false when the master flag is off, even with every field filled', () => {
    // The flag is kept separate from emptiness so switching the injector off and back on restores the
    // previous form instead of clearing it — the same reasoning as the simulator's master switch.
    expect(isDemandArmed({ ...complete, enabled: false })).toBe(false);
  });

  it.each(['dealId', 'steamTradeId', 'proveAfter'] as const)('is false while %s is still empty', (field) => {
    // An operator mid-form has not asked for anything yet. A mark with no trade id IS a state the core must
    // handle — it reports it unbindable and nobody can answer it — but there is no reason for a dev tool to
    // manufacture one and hand its operator a ProofSuppressed to diagnose.
    expect(isDemandArmed({ ...complete, [field]: '' })).toBe(false);
  });
});
