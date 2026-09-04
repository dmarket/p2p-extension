// Dev-only service-worker message router for the debug console. Handles `debug:*` requests only,
// including "force tick" (`debug:force-tick`): it calls the core's `forceHeartbeat`, which marks the
// heartbeat due and so bypasses the backend-ttl cadence gate that makes a plain `deliverPush` nudge a
// no-op between heartbeats. It awaits the real cycle, then resolves the blocking reason (Steam-account
// mismatch / missing session / not-activated / tracker down) and writes a visible command log entry, so
// the reported outcome is never a blind "tick forced". Registered alongside the bridge router; both
// listeners coexist because each returns `undefined` for messages it doesn't own.

import { Tracker, type BlockingReason, type TrackerHandle } from '@/core/tracker';
import { supportsOffscreenProver } from '@/core/notary-delegate';
import { isNotaryPhaseMessage } from '@/core/notary-messages';
import { NOTARY_TRACE_EVENT } from '@/core/notary-trace';
import { redactSecrets } from '@/util/redact';
import { isActivated } from '@/state/activation';
import { getLinkedSteamId } from '@/state/blocking';
import { clearLogs, readAllLogs } from '@/debug/sessionLog';
import { logCommand } from '@/debug/netLog';
import { lastProofOutcome, recordProofStage, runningProof } from '@/debug/proofState';
import { blockingStateNote } from '@/debug/blockingStates';
import { DEMAND_KEY, isDemandArmed, parseDemand } from '@/debug/demandState';
import { applyDemand, applySimulation, clearResidue, describeSimulation, effectiveDemand, effectiveSimulation } from '@/debug/simulate';
import { armedScenarios, parseSimulation, SIMULATION_KEY } from '@/debug/simulationState';
import { isRemoteConfigEnabled } from '@/infra/config';
import {
  fetchRemoteConfig,
  readCachedEntries,
  REMOTE_CONFIG_FETCHED_AT_KEY,
  REMOTE_CONFIG_PARAM,
  type ConfigEntries,
} from '@/infra/remoteConfig';
import {
  ALLOWED_ORIGINS_KEY,
  API_URL_KEY,
  describeAge,
  FE_URL_KEY,
  isDebugRequest,
  NOTARY_URL_KEY,
  TICK_ALARM_NAME,
  type DebugRequest,
  type DebugResponse,
  type ProverKind,
} from '@/debug/protocol';
import { getSettings, type TrackerOverrides } from '@/config/settings';

/** The core's vault row for the Steam credential. Only its public `steam_id` is ever read here. */
const STEAM_CREDENTIAL_KEY = 'steam_credential';

/** Hooks the debug router needs from the background boot to describe/control the running tracker. */
export interface DebugDeps {
  getHandle: () => TrackerHandle | undefined;
  /** The two endpoints the tracker is currently running against. */
  getEndpoints: () => { apiUrl: string; feUrl: string };
  /** Stop the current tracker and restart it against the given endpoints. */
  restart: (apiUrl: string, feUrl: string) => void;
  /**
   * The notary WebSocket the core is EFFECTIVELY running against (remote config, with the dev-only
   * override applied), or `null` when this extension is overriding nothing — which since core `.194` means
   * the core's own production default applies, NOT that there is no notary. Must be read from the overrides
   * the tracker was actually started with, not from the debug key alone — see `DescribeResult.notaryUrl`.
   */
  getNotaryUrl: () => string | null;
  /** Point the notary at [url] (or `null` to drop back to a publish / the core's default) and restart. */
  setNotaryUrl: (url: string | null) => void;
  /**
   * Apply the blocking-state simulator's core-config overrides (`null` = none) and restart the core.
   *
   * Takes the already-resolved overrides rather than the simulation state: how a state is produced is
   * src/debug/simulate.ts's business, and background.ts must stay able to hold the value without knowing
   * what a scenario is (it also has no way to import that module outside its dev-gated branch).
   */
  setSimulationOverrides: (overrides: TrackerOverrides | null) => void;
  /**
   * Re-write the persisted blocking reason every surface reads, now.
   *
   * Needed because a simulation change can alter what the surfaces should show WITHOUT altering the core's
   * configuration — arming the wrong-account scenario, or flipping the master switch, changes the override
   * (`simulatedReason`) while the core runs on exactly the same config, so there is no restart and therefore
   * no cycle to carry the new value.
   */
  refreshBlockingMirror: () => void;
  /**
   * Hands the debug log's lifecycle sink to the already-running core callback. Inverted this way round
   * because the core is started (with its `onLifecycleEvent`) synchronously at boot, while this whole module
   * tree only arrives on a later microtask — and because production must keep no reference to it at all.
   */
  setLifecycleSink: (sink: (json: string) => void) => void;
}

/** Whether two entries maps hold the same parameters — key order is not guaranteed across JSON parses. */
function sameEntries(a: ConfigEntries, b: ConfigEntries): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k, i) => k === bKeys[i] && a[k] === b[k]);
}

async function fetchedAt(): Promise<number | null> {
  try {
    const stored = await browser.storage.local.get(REMOTE_CONFIG_FETCHED_AT_KEY);
    const at = stored[REMOTE_CONFIG_FETCHED_AT_KEY];
    return typeof at === 'number' ? at : null;
  } catch {
    return null;
  }
}

/** The core's blocking reason, or `'NONE'` when the handle isn't ready (same fail-open as the presence path). */
function safeReason(tracker: TrackerHandle): BlockingReason {
  try {
    return Tracker.blockingReason(tracker);
  } catch {
    return 'NONE';
  }
}

/**
 * One line explaining what a non-NONE reason means for a forced cycle, for the visible command log.
 * Sourced from the state catalog (src/debug/blockingStates.ts) so the console cannot describe a state
 * differently from how the same console documents it in the storage panel.
 */
const blockedNote = blockingStateNote;

/**
 * The account ids the wrong-account verdict is computed from, for the console's status pills.
 *
 * `linked` is the host's mirror of the backend's `linkedSteamId` (only the mismatch lifecycle event carries
 * it, so it is read from where the background persisted it, not off the handle). `credential` is the subject
 * of the vault row the core is acting as — read straight out of storage rather than through the seam, since
 * the credential itself is deliberately never exported across the JS boundary. Only the public ids are read;
 * the row's token is not touched.
 */
async function accountIds(): Promise<{ linkedSteamId: string | null; credentialSteamId: string | null }> {
  const linkedSteamId = (await getLinkedSteamId().catch(() => undefined)) ?? null;
  let credentialSteamId: string | null = null;
  try {
    const raw = (await browser.storage.local.get(STEAM_CREDENTIAL_KEY))[STEAM_CREDENTIAL_KEY];
    if (typeof raw === 'string') {
      const parsed = JSON.parse(raw) as { steam_id?: unknown };
      if (typeof parsed.steam_id === 'string') credentialSteamId = parsed.steam_id;
    }
  } catch {
    /* absent, or a shape this build doesn't know — the pill just shows a dash */
  }
  return { linkedSteamId, credentialSteamId };
}

async function nextTickAt(): Promise<number | null> {
  try {
    const alarm = await browser.alarms.get(TICK_ALARM_NAME);
    return alarm?.scheduledTime ?? null;
  } catch {
    return null;
  }
}

/**
 * Which prover the core resolved. Mirrors the core's own selection predicate, which since `.194` is the
 * proof delegate and nothing else — `NotaryConfig.notaryUrl` defaults to the production notary, so a
 * configured URL no longer distinguishes anything. What decides is whether this runtime can host the
 * prover: Firefox cannot cross-origin-isolate an extension page, so `Tracker.start` withholds the
 * delegate there and the core keeps the no-op prover.
 *
 * It used to read `notaryUrl !== null && supportsOffscreenProver()`. Keeping that term would now REPORT
 * the old model rather than the live one: an operator who clears the console's notary field with nothing
 * published leaves the core on its own default — armed — and this would have called it `noop`.
 */
const resolveProver = (): ProverKind => (supportsOffscreenProver() ? 'tlsn' : 'noop');

/**
 * Write the proof path's configuration into the session log, once per spawn.
 *
 * A session in which no proof was ever attempted otherwise carries no record of whether the prover was even
 * switched on — which is exactly the state this path shipped in, and the reason an empty `proofPayload` read as
 * a broken proof builder rather than as a disabled feature. `DescribeResult` answers it in the live UI only:
 * the log export serialises entries alone, so the artifact that travels lost it. The deadline is worse than
 * absent there — nothing reports it at all until it fires.
 *
 * ACCEPTED RESIDUAL: a remote-config publish that changes `notary.notaryUrl` mid-session reaches the running
 * core without a spawn, so this states the configuration as of the last spawn, not necessarily as of the next
 * proof. Closing that needs a dev-gated hook out of `reconcileOverrides`.
 */
export function logProverConfiguration(deps: DebugDeps): void {
  const notaryUrl = deps.getNotaryUrl();
  void logCommand(
    NOTARY_TRACE_EVENT,
    `session: prover=${resolveProver()} notaryUrl=${notaryUrl ?? "(core's own default)"} ` +
      `proofTimeoutMs=${getSettings().web.notaryProofTimeoutMs} ` +
      // The inner bound, and the one a misfire would show up as: proofs failing in ~25 s with a "wedged"
      // line rather than at the deadline. `0` here means that watch is switched off.
      `stuckAfterMs=${getSettings().web.notaryStuckAfterMs}`,
  );
}

async function handle(request: DebugRequest, deps: DebugDeps): Promise<DebugResponse> {
  switch (request.type) {
    case 'debug:describe': {
      const { apiUrl, feUrl } = deps.getEndpoints();
      const tracker = deps.getHandle();
      const notaryUrl = deps.getNotaryUrl();
      return {
        ok: true,
        version: Tracker.version(),
        hasSession: tracker !== undefined,
        nextTickAt: await nextTickAt(),
        apiUrl,
        feUrl,
        notaryUrl,
        prover: resolveProver(),
        lastProof: lastProofOutcome() ?? null,
        // …and whether one is running as this poll is answered. Without it the pill above, which describes a
        // finished proof, was the only proof state the console had — so the 17 s a healthy proof takes read
        // as a stalled header.
        runningProof: runningProof() ?? null,
        // The core's live reason, so the console can show it next to the persisted mirror and the cookie
        // traffic-lights — a disagreement between those three is exactly what a state-plumbing bug looks
        // like. Never throws the poll: a not-ready handle reports null.
        blockingReason: tracker === undefined ? null : safeReason(tracker),
        simulation: effectiveSimulation(),
        demand: effectiveDemand(),
        ...(await accountIds()),
      };
    }

    case 'debug:get-log':
      return { ok: true, entries: await readAllLogs() };

    case 'debug:clear-log':
      await clearLogs();
      return { ok: true };

    case 'debug:force-tick': {
      const tracker = deps.getHandle();
      if (tracker === undefined) {
        await logCommand('ForceTick', 'blocked: tracker not started (service worker asleep or boot failed)', 'error');
        return { ok: false, error: 'tracker not started' };
      }
      const activated = await isActivated();
      // Force an IMMEDIATE heartbeat via the core's dedicated entrypoint. This bypasses the backend-ttl
      // cadence gate: forceHeartbeat marks the heartbeat due, so the cycle always POSTs /heartbeat and
      // re-evaluates the account binding — letting a resolved mismatch clear. Only Steam directives/
      // deal-watch stay gated on a mismatch; the heartbeat is not. We await the actual cycle, so the
      // outcome below is truthful (no blind "tick forced").
      try {
        await Tracker.forceHeartbeat(tracker);
      } catch (error) {
        await logCommand('ForceTick', `forceHeartbeat failed: ${String(error)}`, 'error');
        return { ok: false, error: String(error) };
      }
      // Resolve why the forced cycle might still not create trades — read AFTER the awaited cycle: a
      // fresh idle worker's in-memory reason is NONE until a heartbeat runs, so a pre-force read would
      // log a stale all-clear. Fail-open on a not-ready handle (matches the presence path).
      const reason = safeReason(tracker);
      if (reason !== 'NONE') {
        await logCommand('ForceTick', `heartbeat forced — ${blockedNote(reason)}`, 'error');
        return { ok: true, reason };
      }
      if (!activated) {
        await logCommand('ForceTick', 'heartbeat forced — extension not activated, so no trade cycle runs until onboarding is completed.', 'warn');
        return { ok: true, reason, blocked: 'inactive' };
      }
      // Not just "heartbeat forced". The forced cycle can complete perfectly while skipping the proof it
      // was forced for, and that read as an unqualified success — the reason "why is there no /notary
      // POST?" had to be answered by hand. Read AFTER the awaited cycle, so it reflects THIS tick.
      //
      // The AGE is not decoration. This outcome outlives its cycle, so the line is printed even when this
      // tick attempted nothing — and it was: a forced tick on a heartbeat that returned no `activeTracking`
      // at all still reported "proof NOT ATTEMPTED", which was read as this tick's verdict rather than as a
      // frame from minutes earlier, about a deal the backend had since stopped tracking. `just now` vs
      // `4m ago` is the difference between "the cycle I just ran skipped a proof" and "nothing happened".
      const proof = lastProofOutcome();
      if (proof && !proof.ok) {
        await logCommand('ForceTick', `heartbeat forced — proof ${proof.text} (${describeAge(proof.at, Date.now())})`, 'warn');
        return { ok: true, reason };
      }
      await logCommand('RequestCycle', 'heartbeat forced', 'info');
      return { ok: true, reason };
    }

    case 'debug:retry-proof': {
      // The ONLY host-side way to clear the core's refused-proof latch: it is an in-memory field on the
      // loop, so a fresh loop instance is the whole mechanism. `restart` stops and starts the tracker and
      // already fires one `forceHeartbeat` afterwards, so the retry cycle runs immediately rather than
      // waiting out the backend ttl.
      //
      // Deliberately blunt, and worth saying why: a surgical retry would need the core to export something
      // that clears just that set. Until it does, a restart is the honest option — and it is exactly what
      // reloading the extension was doing, minus the reload.
      const { apiUrl, feUrl } = deps.getEndpoints();
      deps.restart(apiUrl, feUrl);
      await logCommand(
        'RetryProof',
        'tracker restarted — the refused-proof latch is gone with the old loop instance, so the next cycle proves again',
        'info',
      );
      return { ok: true };
    }

    case 'debug:refresh-config': {
      // Force a Remote Config fetch NOW, past the 1h client-side refetch throttle, so a just-published
      // document can be pulled without waiting (or clearing storage). The POST itself is captured by the
      // dev fetch wrap, so the raw request/response is visible in the log alongside the note below.
      //
      // fetchRemoteConfig never throws and silently falls back to the cache on any failure, so success is
      // resolved out of band: the fetch stamp is written ONLY on an ok response, hence "the stamp
      // advanced" == "the POST completed". Applying a changed document needs nothing here — writing the
      // cache fires storage.onChanged, which reconciles the core's overrides (restarting it only if
      // tracker.* actually differs) and re-applies the anti-CSRF rules.
      const before = await readCachedEntries();
      const beforeAt = await fetchedAt();
      const entries = await fetchRemoteConfig(true);
      const afterAt = await fetchedAt();
      const fetched = afterAt !== null && afterAt !== beforeAt;
      const changed = !sameEntries(before, entries);
      const paramCount = Object.keys(entries).length;
      const result = { ok: true as const, enabled: isRemoteConfigEnabled(), fetched, changed, paramCount };

      if (!result.enabled) {
        await logCommand(
          'RefreshConfig',
          'remote config not configured (WXT_FIREBASE_* unset in .env) — no request made; the cached/compiled defaults stay in effect.',
          'warn',
        );
      } else if (!fetched) {
        await logCommand(
          'RefreshConfig',
          'remote config fetch failed (network error or non-2xx) — the cached values are kept. Check the firebaseremoteconfig entry in the log; a packaged build also needs the firebaseremoteconfig.googleapis.com host permission (added only when all three WXT_FIREBASE_* are set).',
          'error',
        );
      } else if (paramCount === 0) {
        // The fetch succeeded but the template carries no `p2p_tracker_config` (the only parameter we
        // cache) — usually it was never created/published. Everything falls back to compiled defaults.
        await logCommand(
          'RefreshConfig',
          `remote config fetched, but the template has no ${REMOTE_CONFIG_PARAM} parameter — the compiled defaults are in effect${changed ? ' (any previously cached overrides were dropped)' : ''}. Create + publish it in the Firebase console.`,
          'warn',
        );
      } else if (changed) {
        await logCommand(
          'RefreshConfig',
          `${REMOTE_CONFIG_PARAM} updated (${entries[REMOTE_CONFIG_PARAM]?.length ?? 0} chars cached). Applied immediately: the core restarts if tracker.* changed, web.* is read at use-time.`,
          'info',
        );
      } else {
        await logCommand('RefreshConfig', `${REMOTE_CONFIG_PARAM} fetched — unchanged.`, 'info');
      }
      return result;
    }

    case 'debug:set-endpoints': {
      // Persist the overrides (re-applied on the next worker spawn) and restart the tracker now.
      await browser.storage.local.set({ [API_URL_KEY]: request.apiUrl, [FE_URL_KEY]: request.feUrl });
      // Let the page bridge accept + push to this FE origin too (union with any previously recorded).
      try {
        const origin = new URL(request.feUrl).origin;
        const existing = (await browser.storage.local.get(ALLOWED_ORIGINS_KEY))[ALLOWED_ORIGINS_KEY];
        const list = Array.isArray(existing) ? existing.filter((o): o is string => typeof o === 'string') : [];
        if (!list.includes(origin)) list.push(origin);
        await browser.storage.local.set({ [ALLOWED_ORIGINS_KEY]: list });
      } catch {
        /* invalid FE URL — skip seeding the allow-list */
      }
      deps.restart(request.apiUrl, request.feUrl);
      return { ok: true };
    }

    case 'debug:set-notary': {
      // Trimmed here rather than in the page so a stored value is always either a usable URL or absent —
      // the boot path reads this key directly and does no validation of its own.
      const url = request.notaryUrl.trim() || null;
      await browser.storage.local.set({ [NOTARY_URL_KEY]: url ?? '' });
      await logCommand(
        'SetNotary',
        url === null
          ? 'notary cleared — the core falls back to a published URL, or to its own default.'
          : `notary set to ${url}; the core restarts and selects the real prover. Proofs run in the offscreen document — open its own DevTools (chrome://extensions → Inspect views: offscreen.html) for the MPC stack.`,
        'info',
      );
      deps.setNotaryUrl(url);
      return { ok: true };
    }

    case 'debug:set-simulation': {
      // Read the previous state BEFORE overwriting it: a scenario that is being turned OFF is the only
      // thing that can leave core loop state behind, and clearing that is what makes a disarm
      // deterministic instead of "whatever the next cycle re-derives" (see clearResidue).
      const before = parseSimulation((await browser.storage.local.get(SIMULATION_KEY))[SIMULATION_KEY]);
      const after = parseSimulation(request.state);
      await browser.storage.local.set({ [SIMULATION_KEY]: after });
      await clearResidue(before, after);
      // Installs the rails and resolves the core overrides in one step, so the rails are in place before
      // the restart's forced heartbeat — which is the first thing that could reach Steam.
      const overrides = applySimulation(after);
      // `warn` whenever anything is armed, not just when core config changed: two of the scenarios need no
      // config at all, and a session log that renders a simulated outage as an ordinary note is how a
      // simulated state gets mistaken for a real one.
      const armed = armedScenarios(after);
      // Changes apply instantly now (there is no apply button), so the master switch alone is a common
      // click — and with nothing armed it changes nothing in effect. Restarting the core for it would cost
      // a stop/start plus a forced heartbeat for no reason, and re-arm the core's per-episode Steam latches
      // on the way through.
      const wasArmed = armedScenarios(before);
      const sameEffect = wasArmed.length === armed.length && wasArmed.every((s) => armed.includes(s));
      await logCommand('Simulation', describeSimulation(armed), armed.length > 0 ? 'warn' : 'info');
      if (!sameEffect) deps.setSimulationOverrides(overrides);
      // Always, even when the core config did not change: the override that decides what the surfaces render
      // has changed, and without this the popup would keep the previous state until something else wrote it.
      deps.refreshBlockingMirror();
      return { ok: true };
    }

    case 'debug:set-demand': {
      const after = parseDemand(request.state);
      await browser.storage.local.set({ [DEMAND_KEY]: after });
      // No restart, deliberately: this rewrites a heartbeat RESPONSE, so the next heartbeat carries it.
      // Restarting would cost a forced heartbeat and re-arm the core's per-episode Steam latches for
      // something that is not core config at all — and it would not make the mark arrive any sooner.
      applyDemand(after);
      if (!isDemandArmed(after)) {
        void logCommand(DEMAND_EVENT, 'freshness mark disarmed — heartbeats pass through unchanged again.', 'info');
        return { ok: true };
      }
      // `warn`, like every other synthesized reply: a session log that renders an injected mark as an
      // ordinary note is how a hand-stamped demand gets mistaken for one the backend actually sent.
      void logCommand(
        DEMAND_EVENT,
        `freshness mark armed for ${after.dealId}: proveAfter=${after.proveAfter}, ` +
          `steamTradeId=${after.steamTradeId}. It is stamped onto that deal's entry on every heartbeat, and ` +
          'the core answers it ONCE — raise the instant to ask again.',
        'warn',
      );
      return { ok: true };
    }
  }
}

/** Command-log tag for the freshness-mark injector, so its entries are filterable like the others. */
const DEMAND_EVENT = 'InjectDemand';

/**
 * Register the debug message router. Must be called synchronously on every worker spawn (via the
 * dev-gated boot in background.ts).
 */
export function registerDebugRouter(deps: DebugDeps): void {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // The proving realm's narration, on the way to the session log. Ahead of the request guard because it is
    // not a request — it expects no reply, so returning `undefined` here closes the port immediately.
    // `redactSecrets` is not optional: `logCommand` stores `note` verbatim, and this text is composed in
    // another realm from a prover error whose message can name the proven read — whose query string carries
    // the Steam access token.
    if (isNotaryPhaseMessage(message)) {
      const note = redactSecrets(message.note);
      // The stage lines are also the only live read on WHERE a running proof is, so they feed the header pill
      // as well as the log. Scrubbed value on purpose: the parse keeps only the step name, but nothing on this
      // path should ever be reading the unscrubbed note.
      recordProofStage(note, Date.now());
      void logCommand(NOTARY_TRACE_EVENT, `offscreen: ${note}`, message.level ?? 'info');
      return undefined;
    }
    if (!isDebugRequest(message)) return undefined;
    handle(message, deps)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error) } satisfies DebugResponse));
    return true; // keep the message channel open for the async response
  });
}
