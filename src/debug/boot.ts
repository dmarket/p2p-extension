// Dev-only debug bootstrap. Dynamically imported behind `import.meta.env.PROD` in background.ts, so
// this module (and everything it pulls in — fetch-wrap, IndexedDB store, debug router) is dropped
// entirely from production builds.
//
// Ordering note: the dynamic import resolves on a microtask AFTER background.ts's synchronous top
// level (i.e. after Tracker.start). That's still fine — the core kicks an immediate cycle at boot
// (it is NOT alarm-gated), but its coroutines resume via setTimeout (macrotasks), so the microtask
// that installs the fetch wrap always lands before the cycle's first request.
//
// The blocking-state simulator (src/debug/simulate.ts) is deliberately NOT installed from here: it is
// applied inside bootCore, BEFORE the first Tracker.start, because one of its fetch rails exists to stop
// the core's Steam session mint from rotating a real session — and the boot cycle can reach Steam. That
// also puts its wrap INSIDE the network log's, so the log reports what the core actually saw.

import { installNetLog, logCommand, logLifecycle } from '@/debug/netLog';
import { logProverConfiguration, registerDebugRouter, type DebugDeps } from '@/debug/router';
import { API_URL_KEY, FE_URL_KEY } from '@/debug/protocol';
import { setNotaryTraceSink } from '@/core/notary-trace';

export async function installDebug(deps: DebugDeps): Promise<void> {
  installNetLog();
  // The proof path's own narration. Same inversion as the lifecycle sink below, and for the same reason:
  // `src/core/notary-delegate.ts` ships in production and cannot import this tree. Without it the log shows
  // only the `/notary` POST that carries a finished presentation — see src/core/notary-trace.ts for why
  // everything upstream of that POST is invisible to `netLog` by construction.
  setNotaryTraceSink((event, note, level) => void logCommand(event, note, level));
  // …and state the configuration once, so a session with no proof in it still says whether one was possible.
  logProverConfiguration(deps);
  // The core's own narration, into the same ring buffer as the captured traffic — without it the log shows
  // only what went over the wire, and a cycle that decided to send nothing is indistinguishable from one
  // that could not see anything. `void`: the append is async, the core's callback is not.
  deps.setLifecycleSink((json) => void logLifecycle(json));
  registerDebugRouter(deps);

  // Safety net only. background.ts resolves the stored endpoint overrides BEFORE the first
  // Tracker.start (see `bootCore`), so in the normal path this finds nothing to change and does not
  // restart anything. It still fires when boot threw before `currentApiUrl`/`currentFeUrl` were
  // assigned — i.e. as a retry of a failed start — which is the only reason it is still here.
  try {
    const stored = await browser.storage.local.get([API_URL_KEY, FE_URL_KEY]);
    const current = deps.getEndpoints();
    const apiUrl = typeof stored[API_URL_KEY] === 'string' && stored[API_URL_KEY] ? stored[API_URL_KEY] : current.apiUrl;
    const feUrl = typeof stored[FE_URL_KEY] === 'string' && stored[FE_URL_KEY] ? stored[FE_URL_KEY] : current.feUrl;
    if (apiUrl !== current.apiUrl || feUrl !== current.feUrl) {
      deps.restart(apiUrl, feUrl);
    }
  } catch {
    /* storage unavailable — keep the default endpoints */
  }

  console.info('[dmarket-p2p] debug console enabled — open debug.html');
}
