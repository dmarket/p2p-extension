// Apply a pending extension update without waiting for a browser restart.
//
// WHY. Chrome installs an MV3 extension's update only while the extension is idle: no background host, no
// extension frame and no extension process (`UpdateInstallGate::ShouldDelay` → `util::IsExtensionIdle`). The
// offscreen document that hosts the notary prover is an extension frame, and it stays open between proofs on
// purpose — it keeps the wasm instance warm for `web.notaryProofsPerInstance` proofs. So after the first proof
// the extension is never idle again, and every update Chrome downloads waits for the browser to restart. For a
// seller who keeps Chrome open for weeks, that is weeks on an old build.
//
// HOW. A deferred update is announced: Chrome dispatches `runtime.onUpdateAvailable` when it parks an update
// for idleness (`chrome_extension_registrar_delegate.cc`, `kWaitForIdle`), and `runtime.reload()` on an
// extension with a parked update installs it immediately (`ExtensionRegistrar::DoReloadExtension` →
// `FinishDelayedInstallationIfReady(install_immediately = true)`). So the listener only has to pick the moment.
//
// THE MOMENT. Not mid-proof: a proof costs tens of seconds and tens of MB of MPC traffic, and a reload throws
// all of it away. Everything else the worker does is already written to survive being killed at any point —
// MV3 terminates the worker whenever it likes — so a reload between proofs costs nothing a respawn wouldn't.
// The wait is capped at the proof deadline plus a margin: a proof cannot legitimately outlive its own timeout,
// so anything still "in flight" past that is a leak, and a leaked bracket must not pin the old build forever.
//
// SURVIVING THE WORKER. `onUpdateAvailable` fires once. If the worker is evicted while it waits, the event is
// gone, so the intent is written to `storage.session` and re-read on the next spawn. That storage is cleared on
// reload and on update, i.e. exactly when the intent has been fulfilled — so the mark cannot outlive its update.

import { getSettings } from '@/config/settings';

const PENDING_KEY = 'update.pendingVersion';

/** Poll interval while a proof is in flight. Short: the reload should follow the proof, not trail it. */
const POLL_MS = 2_000;

/** Added to the proof deadline: time for the timed-out proof's own teardown to finish. */
const DEADLINE_MARGIN_MS = 15_000;

export interface UpdateDeps {
  /** `true` while something that must not be cut short is running. Today: a notary proof. */
  isBusy: () => boolean;
  /** Overridable for tests; the real one is `browser.runtime.reload`. */
  reload?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

let applying: Promise<void> | null = null;

/**
 * Register the `onUpdateAvailable` listener. Call synchronously at service-worker top level: the event wakes
 * a dormant worker only if its listener is registered on the first turn of that worker.
 */
export function registerUpdateReload(deps: UpdateDeps): void {
  browser.runtime.onUpdateAvailable.addListener((details) => {
    const version = typeof details?.version === 'string' ? details.version : 'unknown';
    void markPending(version).then(() => applyWhenIdle(deps, version));
  });
}

/**
 * Finish an update an earlier worker was waiting to apply when it was evicted. Call once per spawn; a no-op
 * when nothing is pending.
 */
export async function resumePendingUpdate(deps: UpdateDeps): Promise<void> {
  let version: unknown;
  try {
    version = (await browser.storage.session.get(PENDING_KEY))[PENDING_KEY];
  } catch {
    return;
  }
  if (typeof version !== 'string') return;
  await applyWhenIdle(deps, version);
}

/** Wait for the worker to be free (bounded), then reload onto the pending version. Single-flight. */
export function applyWhenIdle(deps: UpdateDeps, version: string): Promise<void> {
  applying ??= run(deps, version).finally(() => {
    applying = null;
  });
  return applying;
}

async function run(deps: UpdateDeps, version: string): Promise<void> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const reload = deps.reload ?? (() => browser.runtime.reload());
  // Read when the wait starts, not at module load: the deadline is remote-tunable.
  const maxWaitMs = getSettings().web.notaryProofTimeoutMs + DEADLINE_MARGIN_MS;
  const startedAt = now();

  let forced = false;
  while (deps.isBusy()) {
    if (now() - startedAt >= maxWaitMs) {
      forced = true;
      break;
    }
    await sleep(POLL_MS);
  }
  console.info('[dmarket-p2p] reloading to apply update', {
    version,
    waitedMs: now() - startedAt,
    ...(forced ? { forced: 'a proof outlived its deadline' } : {}),
  });
  reload();
}

async function markPending(version: string): Promise<void> {
  try {
    await browser.storage.session.set({ [PENDING_KEY]: version });
  } catch {
    /* no session storage: the in-memory wait below still applies the update if this worker lives */
  }
}
