import { describe, expect, it } from 'vitest';
import { resolveCreateTradeOutcome } from '@/core/createTradeOutcome';
import { isCreateTradeFailureReason } from '@/messaging/protocol';

describe('the core answering creates_paused during a forced update', () => {
  it('reaches the page as EXT_UPDATE_REQUIRED, not as an unclassified failure', () => {
    expect(resolveCreateTradeOutcome(JSON.stringify({ ok: false, status: 'creates_paused' }))).toEqual({
      ok: false,
      status: 'failed',
      error: '',
      reason: 'EXT_UPDATE_REQUIRED',
    });
  });

  it('is a member of the page-facing closed set', () => {
    expect(isCreateTradeFailureReason('EXT_UPDATE_REQUIRED')).toBe(true);
  });

  it('still hands back the offer for a deal this device already created (a duplicate is not paused)', () => {
    expect(
      resolveCreateTradeOutcome(JSON.stringify({ ok: true, status: 'created', steamOfferId: '9', duplicate: true })),
    ).toEqual({ ok: true, status: 'created', steamOfferId: '9', duplicate: true });
  });
});
