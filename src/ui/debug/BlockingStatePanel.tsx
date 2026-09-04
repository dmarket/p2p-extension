import { useEffect, useRef, useState } from 'preact/hooks';
import { setActivated } from '@/state/activation';
import { normalizeBlockingReason, type BlockingReason } from '@/core/blockingReason';
import { resolveSurface } from '@/state/surface';
import { BLOCKING_STATES, type BlockingStateInfo } from '@/debug/blockingStates';
import { DISARMED, type ScenarioId, type SimulationState } from '@/debug/simulationState';
import type { DescribeResult } from '@/debug/protocol';
import { sendDebug } from '@/ui/debug/messaging';
import { useTransientStatus } from '@/ui/debug/useTransientStatus';

/**
 * The `tracker.blockingReason` row: the precedence chain, what triggers each state, and a simulator for
 * the ones that have a reproducible cause.
 *
 * Why this key gets its own panel instead of the generic storage row:
 *   • It has no useful `edit`. The background mirrors the core's live reason on every `CycleStarted` —
 *     which the core emits at the top of every cycle, including a fully idle one — deliberately without an
 *     in-memory dedupe, precisely so an external edit is corrected. With this console open its own 2 s
 *     poll keeps the worker awake, so a hand-written value survives milliseconds.
 *   • It is the one value that decides what all three surfaces show, and the chain that resolves it was
 *     documented only in source comments. A developer looking at `DM_CONNECTION_ERROR` in the storage
 *     panel had no way to see what put it there, what would clear it, or what outranks it.
 *
 * The row is PINNED by StoragePanel — it renders even when the key is absent, which is exactly the state
 * a fresh install is in and exactly when someone wants the simulator.
 */
export function BlockingStatePanel({
  value,
  activated,
}: {
  /** The raw stored value, or `undefined` when the key does not exist yet. */
  value: unknown;
  /** The live `activation.enabled` value, for the host-owned row's note. */
  activated: unknown;
}): preact.JSX.Element {
  // What the SERVICE WORKER has in effect, not what is merely persisted — the same reason
  // DescribeResult.notaryUrl reports the overrides the tracker was really started with. Re-read after every
  // change instead of echoing the click back: whether a scenario is in effect is the worker's answer.
  const [armed, setArmed] = useState<SimulationState>(DISARMED);
  /**
   * What the CORE resolved, as opposed to what the surfaces are being shown. While a simulation is armed the
   * two deliberately differ (the switcher wins), so the real value has to stay visible or the panel would be
   * hiding the one thing a session is usually being debugged for.
   */
  const [coreReason, setCoreReason] = useState<BlockingReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useTransientStatus();
  /** Monotonic change counter, so a superseded verdict poll stays quiet (see {@link commit}). Named
   *  `…Ref` because it is mutated after render on purpose — which is what tells the hooks lint (and the
   *  next reader) that this is deliberate ref state rather than a value that should have been useState. */
  const changeRef = useRef(0);

  const describe = (): Promise<DescribeResult | null> =>
    sendDebug({ type: 'debug:describe' })
      .then((r) => ('simulation' in r ? r : null))
      .catch(() => null);

  /** Record both facts the worker reports: what is armed, and what the core itself resolved. */
  const absorb = (r: DescribeResult | null): void => {
    if (r === null) return;
    setArmed(r.simulation);
    setCoreReason(r.blockingReason);
  };

  useEffect(() => {
    void describe().then(absorb);
  }, []);

  const stored = normalizeBlockingReason(value);
  const isActivated = activated === true;

  /**
   * WHICH state the surfaces are showing, and which one they would show on the core's own verdict — resolved
   * by calling the very function the popup, the banner and the icon call, rather than comparing reasons here.
   *
   * That distinction is the bug this replaced: matching each row against the reason lit TWO rows at once (a
   * simulated `STEAM_SESSION_MISSING` and a deactivated install both matched), while the surfaces render
   * exactly one — and it is the higher-ranked one. `BlockingStateInfo.surface` is the row's own answer to the
   * same question, and scripts/check-surface-priority.mjs already asserts the two agree, so at most one row
   * can match.
   */
  const shown = resolveSurface(isActivated, stored);
  const realShown = coreReason === null ? null : resolveSurface(isActivated, coreReason);

  /**
   * Apply immediately — there is no apply button. Each change costs one core restart plus the forced
   * heartbeat that makes the new state appear, so the controls are disabled while one is in flight
   * (rapid clicking would otherwise queue restarts).
   *
   * Then WAIT for the core to answer and report what it resolved. That last part is the point: three of
   * the four scenarios render no Steam banner at all and one of them (an erroring backend) is already the
   * steady state on prod, so "nothing visibly happened" is a perfectly normal outcome — and without the
   * core's own verdict there is no way to tell it apart from a simulation that did not take.
   */
  const commit = (next: SimulationState): void => {
    // Only the newest change may write the status: the verdict poll below outlives its own click, so a
    // second toggle must not be narrated by the first one's stale answer.
    const mine = (changeRef.current += 1);
    const wasReason = stored;
    setArmed(next);
    setBusy(true);
    setStatus({ text: 'applying…', tone: 'green' });
    void sendDebug({ type: 'debug:set-simulation', state: next })
      .then((res) => {
        // Unlocked as soon as the worker has acknowledged — NOT after the verdict poll below. Locking the
        // checkboxes for the whole verification would make every toggle feel like a two-second freeze.
        setBusy(false);
        if ('error' in res) {
          setStatus({ text: res.error, tone: 'red' });
          // The checkbox was flipped optimistically; put it back to what the worker actually has.
          void describe().then(absorb);
          return;
        }
        return verdict(mine, next.enabled && next.scenarios.length > 0, wasReason);
      })
      .catch((error: unknown) => {
        setBusy(false);
        setStatus({ text: String(error), tone: 'red' });
      });
  };

  /**
   * Report what the core resolved after a change. Polled rather than slept on: the restart's forced
   * heartbeat settles in well under a second on dev and later on a cold worker, and the answer is the whole
   * point of the pill — three of the four scenarios render no Steam banner, and an erroring backend is
   * already the steady state on prod, so "nothing visibly happened" needs to be distinguishable from
   * "nothing happened".
   */
  const verdict = async (mine: number, armedNow: boolean, wasReason: string): Promise<void> => {
    for (let i = 0; i < 12; i += 1) {
      await new Promise((r) => setTimeout(r, 300));
      if (changeRef.current !== mine) return; // superseded by a newer toggle
      const r = await describe();
      if (r === null) continue;
      absorb(r);
      if (r.blockingReason !== null && (r.blockingReason !== wasReason || i >= 3)) {
        setStatus({
          text: `core: ${r.blockingReason}${r.blockingReason === wasReason ? ' (unchanged)' : ''}`,
          tone: armedNow || r.blockingReason !== 'NONE' ? 'orange' : 'green',
        });
        return;
      }
    }
    setStatus({ text: 'core still cycling', tone: 'orange' });
  };

  const toggleScenario = (id: ScenarioId): void =>
    commit({
      ...armed,
      scenarios: armed.scenarios.includes(id)
        ? armed.scenarios.filter((s) => s !== id)
        : [...armed.scenarios, id],
    });

  const armedCount = armed.enabled ? armed.scenarios.length : 0;

  return (
    // Collapsed by default: it is the longest row in the panel and most sessions never touch it.
    <details class="store-row">
      <summary>
        <span class="store-key">tracker.blockingReason</span>
        <span class={`pill ${stored === 'NONE' ? 'on' : 'off'}`}>{stored}</span>
        {armedCount > 0 && <span class="pill orange">sim: {armedCount}</span>}
      </summary>

      <div class="store-body">
        {/* Controls first, then the outcome line, then prose: the switcher is what this panel is for. */}
        <label class="muted sim-master">
          <input
            type="checkbox"
            checked={armed.enabled}
            disabled={busy}
            onChange={(e) => commit({ ...armed, enabled: (e.target as HTMLInputElement).checked })}
          />{' '}
          simulate blocking states (master switch)
        </label>

        {/* Every switch in ONE strip, so picking a state is a single glance and a single click instead of a
            hunt down a column of paragraphs. The reference list below carries the same states WITHOUT
            controls — the two jobs (switch a state / read what a state means) were fighting for the same row.
            One checkbox meaning throughout: "make THIS state the live one", so a ticked chip and the
            highlighted one always agree. */}
        <div class="sim-switch">
          {BLOCKING_STATES.map((info) => {
            const normal = info.reason === 'NONE';
            const host = info.activation === true;
            // Mutually exclusive with the rest, in both directions and without any bookkeeping: "normal" is
            // DERIVED from nothing being armed, so arming a block unticks it by itself, and ticking it clears
            // them. Clicking it while already ticked re-applies normal (the router skips the core restart when
            // the effective set has not changed), which makes it a reset button too.
            const live = info.surface === shown;
            // What the CORE would have the surfaces show, which is a different question from what is being
            // simulated — the two differ by design while an override is live, and the real state is usually
            // why the panel was opened. Outlined rather than ticked, so the two markers cannot be confused.
            const real = realShown !== null && realShown !== shown && info.surface === realShown;
            // Two modes, and this is the distinction that was confusing: with the master switch ON the boxes
            // are the SELECTION (what to simulate); with it OFF nothing is simulated, so they are a read-only
            // picture of REALITY — otherwise "Normal" sat ticked while the live state was "No DMarket".
            //
            // The activation box is the exception in BOTH modes: it is a control for a real flag, so ticked
            // always means "the flag is off", whether or not a higher-ranked state is the one on screen.
            const checked = host
              ? !isActivated
              : !armed.enabled
                ? live
                : normal
                  ? armed.scenarios.length === 0 && isActivated
                  : info.scenario !== undefined && armed.scenarios.includes(info.scenario);
            // Only the activation chip escapes the master switch, because it writes the real flag and works
            // with or without an override. "Normal" does NOT: with the master off there is no override, so
            // ticking it could not make a real block go away — it would just claim to.
            const enabled = !busy && (host || armed.enabled);
            return (
              <label
                key={info.reason}
                // `ok` recolours the healthy state's markers green: red on "Nothing blocking" reads as a
                // problem, which is the opposite of what it means.
                class={`sim-chip${normal ? ' ok' : ''}${checked ? ' on' : ''}${real ? ' real' : ''}${
                  enabled ? '' : ' off'
                }`}
                title={`${info.reason}${real ? ' — THE CORE’S REAL STATE' : ''} — ${
                  !enabled && !host
                    ? 'turn the master switch on first: with it off nothing is simulated and the surfaces show the real state'
                    : normal
                      ? 'back to normal: disarms every simulation and activates the extension'
                      : host
                        ? 'writes activation.enabled = false, which is the real onboarding state'
                        : 'simulate this state by reproducing its cause'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!enabled}
                  onChange={() => {
                    if (normal) {
                      void setActivated(true);
                      commit({ ...armed, scenarios: [] });
                    } else if (host) void setActivated(!isActivated);
                    else toggleScenario(info.scenario as ScenarioId);
                  }}
                />{' '}
                {info.short}
              </label>
            );
          })}
        </div>


        {/* Below every control: what the last change did. Its height is RESERVED whether or not there is
            anything to show — the line appears on each change and clears itself a few seconds later, so a
            slot that collapsed when empty would move everything below it twice per click. */}
        <div class="sim-status">
          {status && (
            <span class={`pill ${status.tone}`} title="what the core reported after the last change">
              {status.text}
            </span>
          )}
        </div>

        <div class="parse-note">
          What the popup, the Steam banner and the toolbar icon render from. No <em>edit</em>: the core rewrites
          it every cycle. Tick a state instead — the cause is really reproduced (cookies hidden, responses
          synthesized), and while the master switch is on the ticks are <strong>authoritative</strong>: an
          unticked state is asserted absent, so a real block cannot outrank a simulated one. The core’s own
          verdict stays visible in the header’s <strong>block:</strong> pill and as <em>← real</em> below.
        </div>

        {/* The same states as reference only — no controls, so reading what a state means never risks
            toggling one. Collapsed per state; the switcher above is where states are changed. */}
        {BLOCKING_STATES.map((info) => (
          <StateRow
            key={info.reason}
            info={info}
            live={info.surface === shown}
            // What the CORE says, marked separately: while the switcher is authoritative the two differ on
            // purpose, and the real state is usually the reason someone opened this panel.
            real={realShown !== null && realShown !== shown && info.surface === realShown}
          />
        ))}
      </div>
    </details>
  );
}

/**
 * One state as REFERENCE: rank, title, the enum name, and the detail behind a disclosure. No control — the
 * switcher strip above owns that. Splitting the two is what made the list readable: a row that was both a
 * switch and a paragraph put the checkbox wherever the text happened to end (the boxes did not even line up
 * between rows), and the detail no operator reads on every visit dominated the panel.
 *
 * Collapsed by default: six states × three dense lines is a wall of text in a 460px column.
 */
function StateRow({
  info,
  live,
  real,
}: {
  info: BlockingStateInfo;
  /** Whether this is the state the SURFACES are showing (the mirror's value, or the activation flag). */
  live: boolean;
  /** Whether this is what the CORE resolved, while the surfaces are being shown something else. */
  real: boolean;
}): preact.JSX.Element {
  return (
    // `ok`: the healthy state's highlight is green, not the red every block gets.
    <details class={`sim-row${live ? ' live' : ''}${info.reason === 'NONE' ? ' ok' : ''}`}>
      <summary>
        <span class="sim-rank">{info.rank}</span>
        <span class="sim-title">{info.title}</span>
        <span class={`pill ${live ? (info.reason === 'NONE' ? 'on' : 'off') : ''}`}>{info.reason}</span>
        {real && (
          <span class="muted" title="what the core actually resolved — the simulation is overriding it">
            ← real
          </span>
        )}
      </summary>
      <div class="sim-detail">
        {info.cause}
        <br />
        <strong>clears:</strong> {info.clears}
        <br />
        {info.surfaces}
        {info.keys.length > 0 && ` · keys: ${info.keys.join(', ')}`}
        {info.note !== undefined && ` · ${info.note}`}
      </div>
    </details>
  );
}
