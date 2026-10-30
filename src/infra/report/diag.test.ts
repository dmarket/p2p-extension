import { describe, expect, it } from 'vitest';
import { DIAG_MAX_BYTES, placeDiag, serializeDiag } from '@/infra/report/diag';

const FULL = {
  outcome: 'timeout',
  proofId: 'a1b2c3d4',
  durationMs: 180_004,
  stage: 'MPC_SETUP',
  stageSec: 171.3,
  elapsedMs: 179_950,
  notarySent: 7_990_897,
  notaryRecv: 2_177_113,
  notaryBuffered: 0,
  notaryIdleMs: 52_000,
  proxySent: 0,
  proxyRecv: 0,
  proxyBuffered: 0,
  proxyIdleMs: 160_000,
  proxyClose: 1000,
  concurrent: 1,
  threadCount: 4,
  cores: 8,
  isolated: true,
  freshWorker: false,
  proverBuild: 'steam-provenance-v1.0.1-3fe3354-1539+3fe335478bb7',
};

describe('serializeDiag — the allowlist', () => {
  it('keeps every allowlisted field of a real snapshot, exactly', () => {
    expect(serializeDiag(FULL)).toEqual(FULL);
  });

  it('drops fields it does not know, ids included, whatever they are called', () => {
    const out = serializeDiag({
      ...FULL,
      dealId: 'a'.repeat(45),
      steamOfferId: '9311607911',
      tradeId: '744935517744884653',
      subjectSteamId: '76561198338780301',
      url: 'https://api.steampowered.com/?access_token=x',
      note: 'free text',
    });
    expect(out).toEqual(FULL);
  });

  it('drops a value of the wrong type or shape instead of coercing it', () => {
    expect(
      serializeDiag({
        outcome: 'boom',
        proofId: 'not-hex!',
        durationMs: -1,
        notarySent: 1.5,
        stageSec: Number.NaN,
        isolated: 'yes',
        stage: 'dealId=abc',
        proverBuild: 'x'.repeat(65),
      }),
    ).toBeUndefined();
  });

  it('passes strings through the report scrubber before matching them', () => {
    // A steamid in a string field becomes `<steamid>` and then fails the pattern: dropped, not sent.
    expect(serializeDiag({ stage: '76561198338780301' })).toBeUndefined();
  });

  it('is never larger than the cap, and undefined when nothing survives', () => {
    expect(JSON.stringify(serializeDiag(FULL)).length).toBeLessThanOrEqual(DIAG_MAX_BYTES);
    expect(serializeDiag(undefined)).toBeUndefined();
    expect(serializeDiag('string')).toBeUndefined();
  });
});

describe('placeDiag — the R12 switch', () => {
  it('field mode: diag is its own field, the message is untouched', () => {
    const diag = serializeDiag(FULL)!;
    expect(placeDiag(diag, 'field')).toEqual({ field: diag, suffix: '' });
    expect(placeDiag(undefined, 'field')).toEqual({ suffix: '' });
  });

  it('suffix mode: folded into the message, numbers bucketed, no per-attempt id', () => {
    const { field, suffix } = placeDiag(serializeDiag(FULL), 'suffix');
    expect(field).toBeUndefined();
    expect(suffix).toMatch(/^ \[diag outcome=timeout durationMs=>=131072 stage=MPC_SETUP /);
    expect(suffix).toContain('notarySent=>=4194304');
    expect(suffix).toContain('cores=8');
    expect(suffix).toContain('isolated=true');
    expect(suffix).not.toContain('a1b2c3d4');
  });
});
