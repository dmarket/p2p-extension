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

export const remoteConfigConfig = {
  apiKey: trimmed(import.meta.env.WXT_FIREBASE_API_KEY),
  projectId: trimmed(import.meta.env.WXT_FIREBASE_PROJECT_ID),
  appId: trimmed(import.meta.env.WXT_FIREBASE_APP_ID),
} as const;

/** True when error reporting has an endpoint to report to. Everything else about it is a no-op otherwise. */
export const isCollectorEnabled = (): boolean => Boolean(collectorConfig.url);

/** True when Firebase Remote Config fetching is configured. */
export const isRemoteConfigEnabled = (): boolean =>
  Boolean(remoteConfigConfig.apiKey && remoteConfigConfig.projectId && remoteConfigConfig.appId);
