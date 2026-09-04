// Shared constants across the extension. Configuration DEFAULTS do not live here — they are
// centralised in src/config/settings.ts (extension-owned + remote-overridable values) and
// src/config/steam.ts (Steam-coupled values); consumers read the resolved snapshot via getSettings().

/** The extension's display name, unified across all surfaces (the Figma mockups vary). */
export const APP_NAME = 'DMARKET TRADE TRACKER';
