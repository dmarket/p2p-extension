import { useEffect, useState } from 'preact/hooks';
import { isActivated, subscribeActivation } from '@/state/activation';
import { getMarketplaceCookieName, getSteamSessionCookieName } from '@/config/settings';
import { STEAM_INTEGRATION } from '@/config/steam';
import { describeAge, describeRunningProof, TICK_ALARM_NAME, type DescribeResult } from '@/debug/protocol';
import { armedScenarios, isArmed, type ScenarioId } from '@/debug/simulationState';
import { sendDebug, forceTick, refreshRemoteConfig } from '@/ui/debug/messaging';

interface ScrapeState {
  present: boolean;
}

/** Probe an auth cookie's presence + non-expiry (works for HttpOnly under the cookies permission). */
async function cookiePresent(url: string, name: string): Promise<ScrapeState> {
  try {
    const c = await browser.cookies.get({ url, name });
    if (!c) return { present: false };
    const expMs = c.expirationDate ? c.expirationDate * 1000 : null;
    return { present: expMs == null || expMs > Date.now() };
  } catch {
    return { present: false };
  }
}

function hostOf(url: string | undefined): string {
  if (!url) return '—';
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * What a simulation is asserting about one session axis: `'absent'` when that state is armed (the core is
 * pointed at a cookie name nothing has), `'present'` when the master switch is on but this axis is NOT armed
 * — which, the switcher being authoritative, is an assertion that this session is fine. `undefined` = no
 * simulation, so the probe speaks for itself.
 */
type SimAxis = 'absent' | 'present' | undefined;

/**
 * A cookie traffic-light: the real jar, read from the PAGE — unless a simulation is in effect, in which case
 * it shows what the SIMULATION asserts, suffixed `(sim)`, with the real probe result kept in the title.
 *
 * That deference is the point. The lights used to always report the jar, so with the switcher authoritative
 * and `No DMarket` UNticked (i.e. "pretend the session is fine") the dmarket light still sat red — flatly
 * contradicting both the switcher and the screen. A light that disagrees with the state the console is
 * showing reads as a plumbing bug, which is exactly what these two exist to rule out.
 *
 * The `(sim)` suffix is a plain conditional: its width is NOT reserved, which was tried and rejected (a
 * permanently held-open box left the pill looking padded). Affordable because the header's left group wraps
 * within itself and the action buttons are pinned outside it.
 */
function pill(label: string, state: ScrapeState | null, host: string, sim: SimAxis): preact.JSX.Element {
  const real = state == null ? 'probing…' : state.present ? 'logged in' : 'logged out / no cookie';
  const present = sim === undefined ? state?.present : sim === 'present';
  const cls = present === undefined ? '' : present ? 'green' : 'red';
  const title =
    sim === 'absent'
      ? `${label} (${host}): SIMULATED ABSENT — the core is pointed at a cookie name nothing has. Really: ${real}.`
      : sim === 'present'
        ? `${label} (${host}): SIMULATED PRESENT — this state is not armed, so the simulation asserts the session is fine. Really: ${real}.`
        : `${label} (${host}): ${real}`;
  return (
    <span class={`pill scrape ${cls}`} title={title}>
      <span class="dot" /> {label}
      {sim !== undefined && ' (sim)'}
    </span>
  );
}

export function StatusPanel(): preact.JSX.Element {
  const [describe, setDescribe] = useState<DescribeResult | null>(null);
  const [activated, setActivatedState] = useState<boolean | undefined>(undefined);
  // Lazy initialiser, not `useState(Date.now())`: the eager form reads the clock on EVERY render and
  // throws the value away on all but the first, which is what the hooks lint objects to. The 1s effect
  // below owns the value from then on.
  const [now, setNow] = useState(() => Date.now());
  const [steam, setSteam] = useState<ScrapeState | null>(null);
  const [dmarket, setDmarket] = useState<ScrapeState | null>(null);
  const [swDown, setSwDown] = useState(false);
  const [configBusy, setConfigBusy] = useState(false);

  // Poll describe (version / session / next-alarm) from the SW every 2s.
  useEffect(() => {
    let alive = true;
    const poll = (): void => {
      sendDebug({ type: 'debug:describe' })
        .then((res) => {
          if (!alive) return;
          if ('version' in res) {
            setDescribe(res);
            setSwDown(false);
          }
        })
        .catch(() => alive && setSwDown(true));
    };
    poll();
    const id = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // 1s clock for the next-tick countdown. Also refresh the live alarm time directly (cheap).
  useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
      void browser.alarms.get(TICK_ALARM_NAME).then((a) => {
        if (a?.scheduledTime) {
          setDescribe((prev) => (prev ? { ...prev, nextTickAt: a.scheduledTime } : prev));
        }
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Activation state (live).
  useEffect(() => {
    void isActivated().then(setActivatedState);
    return subscribeActivation(setActivatedState);
  }, []);

  // Scrape traffic-lights. The dmarket `dm-trade-token` is read/refreshed from the CURRENTLY CONFIGURED
  // FE origin (MarketplaceScrapeConfig.refreshUrl), which is NOT dmarket.com on dev/stage — so
  // probe describe.feUrl, not a hardcoded host, or the pill never reflects a successful dev request.
  // (Non-prod builds add the dev/stage FE origins to host_permissions, so cookies.get can read them.)
  // Steam is always steamcommunity.com. Re-subscribes when the FE URL changes (e.g. endpoint switch).
  const feUrl = describe?.feUrl;
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      // Resolve both cookie NAMES the way production does (remote override or compiled default), so
      // neither light can disagree with what the running core reads. NOTE: the resolved value is only as
      // live as this page's settings snapshot, and the debug entrypoint never calls initSettings() — so
      // today both fall back to the compiled defaults. Wire initSettings() in here to make them track a
      // remote `cookieName` override.
      void cookiePresent(STEAM_INTEGRATION.communityUrl, getSteamSessionCookieName()).then(
        (s) => alive && setSteam(s),
      );
      if (feUrl) {
        void cookiePresent(feUrl, getMarketplaceCookieName()).then((s) => alive && setDmarket(s));
      }
    };
    refresh();
    const id = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [feUrl]);

  // `overdue`, not `0s`, once the scheduled time is behind us.
  //
  // The core's alarm is PERIODIC (`WebExtAlarmsScheduler` arms `periodInMinutes`), so Chrome re-phases it on
  // delivery and a healthy tick just wraps 60s → 0s → 60s — a long cycle does not hold it down, and a proof
  // running inside one is named by the `proof:` pill below, not here. A scheduledTime that STAYS in the past
  // therefore means the one thing this pill could not previously say: the alarm is late. MV3 throttles alarm
  // delivery on battery and under load, and the worker can be mid-eviction, so "the tracker is waiting" and
  // "Chrome has not woken the tracker" are different problems — and `Math.max(0, …)` rendered the second as
  // the first, counting a wait that had already elapsed as though it were about to end.
  //
  // A second of slack, so an on-time tick does not flicker through `overdue` on its way round.
  const overdue = describe?.nextTickAt != null && describe.nextTickAt - now < -1000;
  const countdown = !describe?.nextTickAt
    ? '—'
    : overdue
      ? 'overdue'
      : `${Math.max(0, Math.round((describe.nextTickAt - now) / 1000))}s`;

  // What the SERVICE WORKER has in effect, not what is merely persisted — the same reason
  // DescribeResult.notaryUrl reports the overrides the tracker was really started with.
  const simulation = describe?.simulation;
  const armed = simulation ? armedScenarios(simulation) : [];

  /**
   * What the simulation asserts about one session axis — `undefined` while the master switch is off, so the
   * cookie lights speak for the real jar again. Not armed but switched on is `'present'`: with the switcher
   * authoritative, leaving a state unticked IS the assertion that it is not happening.
   */
  const simAxis = (id: ScenarioId): SimAxis =>
    simulation === undefined || !simulation.enabled ? undefined : isArmed(simulation, id) ? 'absent' : 'present';

  // The three commands below deliberately render NO result in the UI. Every one of them is narrated by the
  // service worker into the session log — `ForceTick`, `RetryProof`, `RefreshConfig`, each with an accurate
  // level (src/debug/router.ts) — so a pill here was a second, shorter copy of a message that is already
  // timestamped, ordered against the traffic that caused it, and included in an export. It also had nowhere
  // to live: on its own row it read as a gap, and beside the buttons it grew the header.
  const onForce = (): void => {
    void forceTick().catch(() => {
      /* the worker is asleep or gone; `session:` above already says so */
    });
  };

  // Restart the tracker to clear the core's refused-proof latch. Blunt by necessity — the latch is an
  // in-memory field on the loop, so a fresh instance is the only host-side handle on it — and it is exactly
  // what reloading the extension was doing anyway. The SW fires one forceHeartbeat after the restart, so
  // the retry cycle runs immediately rather than waiting out the backend ttl.
  const onRetryProof = (): void => {
    void sendDebug({ type: 'debug:retry-proof' }).catch(() => {});
  };

  // Force a Remote Config fetch now (bypasses the 1h client throttle). A changed document is applied by
  // the SW immediately — the core restarts only if `tracker.*` differs; `web.*` is read at use-time.
  const onRefreshConfig = (): void => {
    setConfigBusy(true);
    void refreshRemoteConfig()
      .catch(() => {})
      .finally(() => setConfigBusy(false));
  };

  return (
    <header>
      {/* Left: state you read. Its own wrapping row with `flex: 1`, so growing text here (a cookie light
          gaining "(sim)", a long blocking reason) wraps WITHIN this group instead of pushing the action
          buttons onto another line. */}
      <div class="header-left">
        <h1>P2P Debug Console</h1>
        <span class="pill">{describe ? `v${describe.version}` : 'v…'}</span>
        <span class={`pill ${describe?.hasSession ? 'on' : 'off'}`}>
          session: {swDown ? 'sw asleep' : describe?.hasSession ? 'running' : 'stopped'}
        </span>
        <span class={`pill ${activated ? 'on' : 'off'}`}>
          {activated === undefined ? 'activation: …' : activated ? 'activated' : 'not activated'}
        </span>
        <span
          class={`pill ${overdue ? 'orange' : ''}`}
          title="time until the core's periodic chrome.alarms wake. `overdue` = the scheduled time has passed and Chrome has not delivered it — MV3 throttles alarms on battery and under load. A long cycle does NOT show here: the alarm is periodic and keeps its phase through one."
        >
          next tick: {countdown}
        </span>
        <span class={`pill ${describe?.blockingReason === 'NONE' ? 'on' : describe?.blockingReason ? 'off' : ''}`} title="the core's live blockingReason() — compare it with the mirrored tracker.blockingReason in storage">
          block: {describe?.blockingReason ?? '—'}
        </span>
        {/* The two ids the wrong-account verdict is computed from. Only shown while that verdict is the live
            one — elsewhere they are noise, and `linked` is only learned from a mismatch report anyway. Equal
            ids with the block up = a stale mirror; different ids = the verdict is doing its job; a `linked`
            the user does not recognise = the DMarket profile is linked to another account. */}
        {describe?.blockingReason === 'STEAM_ACCOUNT_MISMATCH' && (
          <span
            class="pill off"
            title="backend linkedSteamId (as mirrored by the host) vs the subject of the credential in the vault — the two inputs to the wrong-account verdict"
          >
            linked {describe.linkedSteamId ?? '—'} / token {describe.credentialSteamId ?? '—'}
          </span>
        )}
        {/* Armed simulations — a simulated block must never be mistaken for a real one, here or in an
            exported log. Shown only while something IS armed: its box used to be held open so the header
            could not re-wrap, which read as an odd gap. Safe to be dynamic now that this group absorbs its
            own growth and the action buttons live outside it. */}
        {armed.length > 0 && (
          <span
            class="pill orange"
            title={`blocking states being simulated: ${armed.join(', ')} — armed from the tracker.blockingReason row in the storage panel`}
          >
            sim: {armed.length} armed
          </span>
        )}
        {/* Which prover the core resolved. Always shown, because `noop` is the normal state and is exactly
            what silently produces an empty `proofPayload` — a backend that enforces proofs then rejects every
            report for that deal until its deadline cancels it, with nothing else in the log naming why. */}
        <span
          class={`pill ${describe?.prover === 'tlsn' ? 'on' : ''}`}
          title={
            describe?.prover === 'tlsn'
              ? `real TLSN prover via ${describe.notaryUrl} — proofs run in the offscreen document`
              : 'no-op prover: proofs are submitted with an EMPTY payload by design, so any deal the backend marks proofRequired cannot settle. Needs a runtime that can host the prover — the notary URL is not the gate, it has a production default.'
          }
        >
          prover: {describe?.prover ?? '—'}
        </span>
        {/* A proof RUNNING right now — and it supersedes the remembered one below, because for the ~17 s it
            takes that verdict is about a different proof and reads as this one's, the exact confusion the
            pill below was supposed to end. The elapsed seconds are the answer to "is it hung?": they tick off
            the page's own 1s clock, so a frozen number means a frozen worker, not a slow poll. */}
        {describe?.runningProof && (
          <span
            class="pill orange"
            title="a proof is being generated right now, in the offscreen document. ~11s of a healthy ~17s proof is MPC pre-processing (stage MPC_SETUP), during which tens of MB go to the notary before Steam is even dialled — so a stage that sits still for a few seconds is normal. The stage is only named while exactly one proof is in flight; the offscreen traces carry no deal id, so with two it cannot be attributed."
          >
            proof: {describeRunningProof(describe.runningProof, now)}
          </span>
        )}
        {/* What actually happened to the last proof. `prover` above says a prover is CONFIGURED; this says
            whether one RAN. The distinction is the whole reason this pill exists: after a single refused
            proof the core stops attempting them, so `prover: tlsn` sat next to no `/p2p/ext/notary` request
            at all and nothing named the gap. Only shown once a proof frame has arrived. */}
        {!describe?.runningProof && describe?.lastProof && (
          <span
            class={`pill ${describe.lastProof.ok ? 'on' : 'off'}`}
            title="the most recent ProofSubmitted / ProofFailed / ProofSuppressed frame from the core, and how long ago it arrived — this pill persists for the worker's lifetime, so the age is what says whether it describes the current deal. NOT ATTEMPTED means the core is deliberately skipping this transition because an identical proof was already refused — use 'retry proof' to get a fresh loop instance."
          >
            proof: {describe.lastProof.text} · {describeAge(describe.lastProof.at, now)}
          </span>
        )}
        {pill('steam', steam, 'steamcommunity.com', simAxis('steam-session-missing'))}
        {pill('dmarket', dmarket, hostOf(feUrl), simAxis('dm-session-missing'))}
      </div>
      {/* Right: the things you press. Nothing else lives here — a command's outcome goes to the session log,
          not into this row (see the handlers above), so the buttons have a fixed home at any width. */}
      <div class="header-right">
        <button onClick={onForce} title="Force an immediate DMarket heartbeat now (core forceHeartbeat)">
          force tick
        </button>
        <button
          onClick={onRetryProof}
          title="Restart the tracker so a refused proof is attempted again. The core latches a verified:false verdict off for the life of the loop instance, and force tick deliberately does not clear it — so with this console open (its polling keeps the worker alive) there was no way to retry short of reloading the extension."
        >
          retry proof
        </button>
        <button
          onClick={onRefreshConfig}
          disabled={configBusy}
          title="Fetch Firebase Remote Config now, bypassing the 1h refetch throttle. A changed config is applied immediately (the core restarts only if tracker.* changed)."
        >
          refresh config
        </button>
      </div>
    </header>
  );
}
