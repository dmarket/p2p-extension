import { ALLOWED_ORIGINS_KEY } from '@/debug/protocol';
import { logCommand } from '@/debug/netLog';

// The manifest carries the page bridge only on the FE origins the build was made with (WXT_DEV_FE_URL /
// WXT_STAGE_FE_URL, the `build:manifestGenerated` hook in wxt.config.ts). An FE applied in the debug console
// is recorded in `debug.allowedOrigins` but got no bridge, so that page reported the extension as installed
// and not answering. This registers the same bridge script on the recorded origins; the service worker
// accepts them in src/background/router.ts. Debug builds only: this file is never bundled into production.

const SCRIPT_ID = 'debug-fe-bridge';

type BridgeEntry = { js?: string[]; matches?: string[] };

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((p) => b.includes(p));

/**
 * Bring the dynamic bridge registration in line with `debug.allowedOrigins`. Idempotent, so it runs on every
 * worker spawn and after every endpoint switch. Never rejects. `announce` writes the outcome to the session
 * log: on for the console's endpoint switch, off on spawn, which happens about once a minute.
 */
export async function syncDebugFeBridge(announce = false): Promise<void> {
  const log = (note: string, level: 'info' | 'error'): Promise<void> =>
    announce ? logCommand('FeBridge', note, level) : Promise.resolve();
  try {
    const entries = (browser.runtime.getManifest().content_scripts ?? []) as BridgeEntry[];
    const bridge = entries.find((cs) => cs.js?.some((j) => j.includes('dmarket-bridge')));
    if (!bridge?.js) return;

    const stored = (await browser.storage.local.get(ALLOWED_ORIGINS_KEY))[ALLOWED_ORIGINS_KEY];
    const wanted = (Array.isArray(stored) ? stored : [])
      .filter((o): o is string => typeof o === 'string')
      .map((o) => `${o.replace(/\/+$/, '')}/*`)
      .filter((p) => !bridge.matches?.includes(p));

    // Without a host permission Chrome registers the script and silently never injects it.
    const granted = await Promise.all(wanted.map((p) => browser.permissions.contains({ origins: [p] })));
    const matches = wanted.filter((_, i) => granted[i]);
    const denied = wanted.filter((_, i) => !granted[i]);
    if (denied.length > 0) {
      await log(
        `no host permission for ${denied.join(', ')}, so the page bridge cannot run there. Rebuild with that FE in WXT_DEV_FE_URL, or its domain in WXT_DEV_COOKIE_DOMAINS.`,
        'error',
      );
    }

    const [current] = await browser.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (!sameSet(current?.matches ?? [], matches)) {
      if (current) await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      if (matches.length > 0) {
        await browser.scripting.registerContentScripts([
          { id: SCRIPT_ID, matches, js: bridge.js, runAt: 'document_idle' },
        ]);
      }
    }
    if (matches.length > 0) {
      await log(`page bridge runs on ${matches.join(', ')}; reload an FE tab that is already open.`, 'info');
    }
  } catch (error) {
    await log(`page bridge registration failed: ${String(error)}`, 'error');
  }
}
