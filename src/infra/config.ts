// Central read of the WXT_-prefixed environment variables that configure the optional integrations.
// Every field is optional; each integration no-ops when its config is absent, so the extension runs
// with an empty .env. See .env.example.

function trimmed(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/**
 * The error collector (the shared DMarket Cloudflare Worker the web frontend also reports to). Debug builds
 * prefer the dev endpoint when one is configured; the dev branch is behind the compile-time
 * `import.meta.env.DEV`, so it is dead-code-eliminated from production bundles.
 */
export const collectorConfig = {
  url: import.meta.env.DEV
    ? (trimmed(import.meta.env.WXT_DEV_COLLECTOR_URL) ?? trimmed(import.meta.env.WXT_COLLECTOR_URL))
    : trimmed(import.meta.env.WXT_COLLECTOR_URL),
} as const;

/** The production remote-config document (buckets/prod/p2p/extension-config.json). A public CDN URL. */
const PROD_REMOTE_CONFIG_URL = 'https://cdn-main.dmarket.com/p2p/extension-config.json';

/**
 * Where the remote-config document is fetched from (src/infra/remoteConfig.ts). Debug builds read the stage
 * document when `WXT_DEV_REMOTE_CONFIG_URL` is set (its host is internal, so it lives in .env) and fall back to
 * production otherwise; the dev branch is dead-code-eliminated from production bundles.
 */
export const remoteConfigConfig = {
  url: import.meta.env.DEV
    ? (trimmed(import.meta.env.WXT_DEV_REMOTE_CONFIG_URL) ?? PROD_REMOTE_CONFIG_URL)
    : PROD_REMOTE_CONFIG_URL,
} as const;

/** True when error reporting has an endpoint to report to. Everything else about it is a no-op otherwise. */
export const isCollectorEnabled = (): boolean => Boolean(collectorConfig.url);
