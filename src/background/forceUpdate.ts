// Forced update: bring an install up to `web.minExtensionVersion`, and tell the page how far along it is.
//
// THE EXTENSION IS THE ONE SOURCE OF TRUTH. It alone knows the minimum (from the bucket config), its own
// version and whether Chrome has the update. The FE does not read the config or compare versions; it renders
// `pong.update` (src/background/router.ts), built by `getUpdateStatus` below. Contract:
// p2p-architecture/specs/fe-extension-interaction.md.
//
// WHAT IT DOES WITH THE RULE. Nothing at all until the own version is below the minimum — in particular it
// never calls `runtime.requestUpdateCheck()` without a rule, which is the API's own guidance. Below it:
//   1. one `requestUpdateCheck()`                                   → state `checking`
//   2. `update_available` → the same path as `onUpdateAvailable`   → state `applying`
//      (`scheduleUpdate`, src/background/update.ts: wait for no proof in flight, then `runtime.reload()`,
//      which installs the parked update with `install_immediately = true`; one reload for both signals)
//   3. `no_update` / `throttled` / an error                         → state `restart_required`
//      and ask again on every later config fetch while the rule holds.
//
// WHY RE-ASKING IS FREE. Every completed check, found or not, starts a ~5 h backoff for this API, and only an
// installed update resets it; a throttled call is answered before any network work
// (chrome/browser/extensions/api/runtime/chrome_runtime_api_delegate.cc: `ShouldRejectRequest` in
// `CheckForUpdates`, `InformOfRequest(false)` in `UpdateCheckComplete`, `Reset()` in `OnExtensionInstalled`).
// Chrome's own periodic check keeps running regardless, and `onUpdateAvailable` catches what it finds. The CI
// raises the minimum only once the update server serves the build (scripts/ci/force-update.sh), so the first
// call normally finds it.
//
// WHERE THE STATE LIVES. `storage.session`: the worker is evicted every few seconds of idleness, and the pong
// must still say `restart_required` after that. Its lifetime matches the API's backoff exactly — both end with
// the browser session — and it is cleared on reload/update, i.e. when the rule may no longer apply.

import { getSettings } from '@/config/settings';
import { isUpdateApplying, scheduleUpdate, type UpdateDeps } from '@/background/update';
import { extensionVersion } from '@/util/extensionVersion';
import { compareVersions, numericVersion } from '@/util/version';

export type UpdateState = 'none' | 'checking' | 'applying' | 'restart_required';

/** `pong.update`. `minVersion` is absent only before the first config document arrives. */
export interface UpdateStatus {
  required: boolean;
  minVersion?: string;
  state: UpdateState;
}

const STATE_KEY = 'update.forced';

interface StoredState {
  /** The minimum this state was reached for. A different minimum is a new rule and starts over. */
  min: string;
  state: Exclude<UpdateState, 'none'>;
}

type CheckResult = { status: string; version?: string };

export interface ForceUpdateDeps extends UpdateDeps {
  /** Overridable for tests; the real one is `browser.runtime.requestUpdateCheck`. */
  requestUpdateCheck?: () => Promise<CheckResult>;
  /** Overridable for tests; the real one is the manifest's numeric version. */
  ownVersion?: () => string;
}

let registered: ForceUpdateDeps = { isBusy: () => false };
let evaluating: Promise<void> | null = null;

/** Hand over the dependencies once, at service-worker top level, next to `registerUpdateReload`. */
export function registerForceUpdate(deps: ForceUpdateDeps): void {
  registered = deps;
}

function ownVersion(): string {
  return registered.ownVersion?.() ?? numericVersion(extensionVersion());
}

function isRequired(min: string | undefined): min is string {
  return min !== undefined && compareVersions(ownVersion(), min) < 0;
}

async function readState(): Promise<StoredState | undefined> {
  try {
    const value: unknown = (await browser.storage.session.get(STATE_KEY))[STATE_KEY];
    if (typeof value !== 'object' || value === null) return undefined;
    const { min, state } = value as Partial<StoredState>;
    if (typeof min !== 'string') return undefined;
    return state === 'checking' || state === 'applying' || state === 'restart_required' ? { min, state } : undefined;
  } catch {
    return undefined;
  }
}

async function writeState(state: StoredState | undefined): Promise<void> {
  try {
    if (state) await browser.storage.session.set({ [STATE_KEY]: state });
    else await browser.storage.session.remove(STATE_KEY);
  } catch {
    /* no session storage: the in-memory path below still applies an update found by this worker */
  }
}

/** What `pong.update` says right now. Cheap: one session-storage read, and only when an update is required. */
export async function getUpdateStatus(min = getSettings().web.minExtensionVersion): Promise<UpdateStatus> {
  if (!isRequired(min)) return { required: false, ...(min !== undefined ? { minVersion: min } : {}), state: 'none' };
  if (isUpdateApplying()) return { required: true, minVersion: min, state: 'applying' };
  const stored = await readState();
  // No state yet for this minimum: an evaluation is about to run (every spawn starts one), so `checking` is
  // the truthful answer — and a stale `checking` from an evicted worker is re-run by that same evaluation.
  return { required: true, minVersion: min, state: stored?.min === min ? stored.state : 'checking' };
}

/**
 * Act on the minimum. Single-flight: a call that lands while one is running joins it.
 *
 * @param recheck ask Chrome again even when this minimum has already ended in `restart_required`. Set on a
 *   completed config fetch — that is the retry cadence — and not on a spawn or a settings reload, which
 *   would otherwise turn every worker respawn into a (throttled) API call.
 */
export function evaluateForceUpdate(min: string | undefined, { recheck = false } = {}): Promise<void> {
  evaluating ??= run(min, recheck).finally(() => {
    evaluating = null;
  });
  return evaluating;
}

async function run(min: string | undefined, recheck: boolean): Promise<void> {
  if (!isRequired(min)) {
    await writeState(undefined);
    return;
  }
  if (isUpdateApplying()) return;
  const stored = await readState();
  if (stored?.min === min && !recheck && stored.state !== 'checking') return;

  await writeState({ min, state: 'checking' });
  let result: CheckResult;
  try {
    result = await (registered.requestUpdateCheck ?? (() => browser.runtime.requestUpdateCheck()))();
  } catch (error) {
    // e.g. the updater is disabled by policy. Nothing more this extension can do; Chrome's restart can.
    result = { status: error instanceof Error ? `error: ${error.message}` : 'error' };
  }
  console.info('[dmarket-p2p] forced update check', { own: ownVersion(), min, ...result });

  if (result.status === 'update_available') {
    await writeState({ min, state: 'applying' });
    void scheduleUpdate(registered, result.version ?? 'unknown');
    return;
  }
  await writeState({ min, state: 'restart_required' });
}
