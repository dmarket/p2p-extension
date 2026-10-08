/**
 * The environment a build boots against when nothing overrides it — the debug console's applied endpoints and a
 * published remote config both win over this.
 *
 * Production builds always take Prod. Debug builds take the first internal environment the gitignored .env
 * configures, in this order: **Stage**, then Dev, then Prod. An environment counts only when BOTH its API and FE
 * URLs are set, because the two are a pair: the core reads the marketplace cookie from the FE origin and calls the
 * API with it, so a Stage API against a Dev FE signs nobody in. The notary belongs to the same environment —
 * `WXT_STAGE_NOTARY_URL` / `WXT_DEV_NOTARY_URL`; without one the build default falls back to the production notary
 * (src/config/notaryUrl.ts), never to another environment's.
 *
 * Every internal URL is read behind `import.meta.env.DEV`, a compile-time constant, so none of them reaches a
 * production bundle (the repository and the shipped build carry no internal hostnames).
 */

export type EnvironmentLabel = 'Prod' | 'Stage' | 'Dev';

export interface BuildEnvironment {
  readonly label: EnvironmentLabel;
  readonly apiUrl: string;
  readonly feUrl: string;
  /** This environment's notary, when configured. Absent → the build default is the production notary. */
  readonly notaryUrl?: string;
}

export const PROD_ENVIRONMENT: BuildEnvironment = {
  label: 'Prod',
  apiUrl: 'https://api.dmarket.com',
  feUrl: 'https://dmarket.com/',
};

interface EnvironmentUrls {
  apiUrl?: string;
  feUrl?: string;
  notaryUrl?: string;
}

const trimmed = (value: string | undefined): string | undefined => value?.trim() || undefined;

/**
 * The internal environments that are fully configured, in the order a debug build prefers them. Shared with the
 * debug console's prefill buttons, so the buttons and the boot default cannot disagree about what "Stage" is.
 */
export function internalEnvironments(urls: { stage: EnvironmentUrls; dev: EnvironmentUrls }): BuildEnvironment[] {
  const out: BuildEnvironment[] = [];
  for (const [label, env] of [['Stage', urls.stage], ['Dev', urls.dev]] as const) {
    const apiUrl = trimmed(env.apiUrl);
    const feUrl = trimmed(env.feUrl);
    if (!apiUrl || !feUrl) continue;
    const notaryUrl = trimmed(env.notaryUrl);
    out.push({ label, apiUrl, feUrl, ...(notaryUrl ? { notaryUrl } : {}) });
  }
  return out;
}

/** What .env configures, read at call time (so a test's `vi.stubEnv` is seen). Debug builds only. */
export function configuredInternalEnvironments(): BuildEnvironment[] {
  if (!import.meta.env.DEV) return [];
  return internalEnvironments({
    stage: {
      apiUrl: import.meta.env.WXT_STAGE_API_URL,
      feUrl: import.meta.env.WXT_STAGE_FE_URL,
      notaryUrl: import.meta.env.WXT_STAGE_NOTARY_URL,
    },
    dev: {
      apiUrl: import.meta.env.WXT_DEV_API_URL,
      feUrl: import.meta.env.WXT_DEV_FE_URL,
      notaryUrl: import.meta.env.WXT_DEV_NOTARY_URL,
    },
  });
}

/** The environment this build boots against by default: Stage > Dev > Prod in a debug build, Prod otherwise. */
export function defaultEnvironment(): BuildEnvironment {
  return configuredInternalEnvironments()[0] ?? PROD_ENVIRONMENT;
}
