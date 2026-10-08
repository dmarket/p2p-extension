import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultEnvironment, internalEnvironments, PROD_ENVIRONMENT } from '@/config/defaultEnvironment';

// Which environment a debug build boots against. Stage first, then Dev, then Prod — and an environment is a
// PAIR: the core reads the marketplace cookie from the FE origin and sends it to the API, so a half-configured
// environment must be skipped, never mixed with another one's half.

const STAGE = { apiUrl: 'https://api.stage.example', feUrl: 'https://fe.stage.example/' };
const DEV = { apiUrl: 'https://api.dev.example', feUrl: 'https://fe.dev.example/' };

describe('internalEnvironments', () => {
  it('lists Stage before Dev', () => {
    expect(internalEnvironments({ stage: STAGE, dev: DEV }).map((e) => e.label)).toEqual(['Stage', 'Dev']);
  });

  it('skips an environment with only one of its two URLs', () => {
    expect(internalEnvironments({ stage: { apiUrl: STAGE.apiUrl }, dev: DEV })).toEqual([{ label: 'Dev', ...DEV }]);
    expect(internalEnvironments({ stage: { feUrl: ' ' , apiUrl: STAGE.apiUrl }, dev: {} })).toEqual([]);
  });

  it('keeps each notary with its own environment and trims the values', () => {
    const [stage, dev] = internalEnvironments({
      stage: { apiUrl: ` ${STAGE.apiUrl} `, feUrl: STAGE.feUrl, notaryUrl: ' wss://stage.example/n/ ' },
      dev: { ...DEV, notaryUrl: '' },
    });
    expect(stage).toEqual({ label: 'Stage', ...STAGE, notaryUrl: 'wss://stage.example/n/' });
    expect(dev).toEqual({ label: 'Dev', ...DEV });
  });
});

describe('defaultEnvironment (debug build — vitest runs with DEV true)', () => {
  // The machine's real .env leaks into import.meta.env under vitest; pin all six values.
  beforeEach(() => {
    for (const k of ['STAGE', 'DEV'] as const) {
      vi.stubEnv(`WXT_${k}_API_URL`, '');
      vi.stubEnv(`WXT_${k}_FE_URL`, '');
      vi.stubEnv(`WXT_${k}_NOTARY_URL`, '');
    }
  });

  it('boots against Stage when it is configured, even with Dev configured too', () => {
    vi.stubEnv('WXT_STAGE_API_URL', STAGE.apiUrl);
    vi.stubEnv('WXT_STAGE_FE_URL', STAGE.feUrl);
    vi.stubEnv('WXT_STAGE_NOTARY_URL', 'wss://stage.example/n/');
    vi.stubEnv('WXT_DEV_API_URL', DEV.apiUrl);
    vi.stubEnv('WXT_DEV_FE_URL', DEV.feUrl);
    vi.stubEnv('WXT_DEV_NOTARY_URL', 'wss://dev.example/n/');
    expect(defaultEnvironment()).toEqual({ label: 'Stage', ...STAGE, notaryUrl: 'wss://stage.example/n/' });
  });

  it('falls back to Dev, and never borrows the Dev notary for Stage', () => {
    vi.stubEnv('WXT_DEV_API_URL', DEV.apiUrl);
    vi.stubEnv('WXT_DEV_FE_URL', DEV.feUrl);
    expect(defaultEnvironment()).toEqual({ label: 'Dev', ...DEV });
    vi.stubEnv('WXT_STAGE_API_URL', STAGE.apiUrl);
    vi.stubEnv('WXT_STAGE_FE_URL', STAGE.feUrl);
    vi.stubEnv('WXT_DEV_NOTARY_URL', 'wss://dev.example/n/');
    expect(defaultEnvironment().notaryUrl).toBeUndefined();
  });

  it('falls back to Prod with nothing configured', () => {
    expect(defaultEnvironment()).toBe(PROD_ENVIRONMENT);
  });
});
