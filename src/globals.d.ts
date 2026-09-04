// Typed access to the WXT_-prefixed environment variables the extension reads (see .env.example).
// Every value is optional: integrations no-op when unset.
interface ImportMetaEnv {
  readonly WXT_DMARKET_API_BASE_URL?: string;
  readonly WXT_DMARKET_FE_URL?: string;
  readonly WXT_DEV_API_URL?: string;
  readonly WXT_DEV_FE_URL?: string;
  readonly WXT_STAGE_API_URL?: string;
  readonly WXT_STAGE_FE_URL?: string;
  readonly WXT_DEV_STEAM_URL?: string;
  readonly WXT_DEV_NOTARY_URL?: string;
  readonly WXT_DEV_NOTARY_ROOT_PEM?: string;
  readonly WXT_COLLECTOR_URL?: string;
  readonly WXT_DEV_COLLECTOR_URL?: string;
  readonly WXT_FIREBASE_API_KEY?: string;
  readonly WXT_FIREBASE_PROJECT_ID?: string;
  readonly WXT_FIREBASE_APP_ID?: string;
}

/**
 * Build identifier injected by the Vite `define` in wxt.config.ts: `<short git sha>+core<version>`.
 * Neither half is available at runtime (`manifest.version` is static, and the core reports a bare
 * `0.1.0-SNAPSHOT`), so this is the only thing that tells one build's crash reports from another's.
 */
declare const __BUILD_ID__: string;
