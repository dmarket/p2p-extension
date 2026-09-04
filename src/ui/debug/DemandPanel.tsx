// The freshness-mark injector (DMA-280), pinned to the storage row that holds its answer.
//
// WHY IT IS HERE and not in the blocking-state simulator beside it: a demand is not a blocking state. It
// neither blocks the tracker nor changes what any surface shows, so it has no row in the state chain — and
// `scripts/check-surface-priority.mjs` would reject one, while a scenario id with no row would make
// `simulatedReason()` answer `NONE` and override a REAL block. See src/debug/demandState.ts.
//
// WHY IT IS PINNED TO `tracker_prove_after`: that row IS the answer. "The mark was stamped but nothing
// happened" is diagnosed by reading the standing the core wrote — did it satisfy the mark, or is it sitting
// on a backoff ladder — so the control and the evidence belong on the same screen.

import { useEffect, useState } from 'preact/hooks';

import { DEMAND_KEY, type DemandInjection, isDemandArmed, NO_DEMAND, parseDemand } from '@/debug/demandState';
import { sendDebug } from '@/ui/debug/messaging';

/** The stored value, or the empty one — the panel renders on a fresh install too, like the simulator. */
function useStoredDemand(): [DemandInjection, (next: DemandInjection) => void] {
  const [state, setState] = useState<DemandInjection>(NO_DEMAND);
  useEffect(() => {
    void browser.storage.local.get(DEMAND_KEY).then((s) => setState(parseDemand(s[DEMAND_KEY])));
  }, []);
  return [state, setState];
}

export function DemandPanel({ value }: { value?: unknown }): preact.JSX.Element {
  const [draft, setDraft] = useStoredDemand();
  const [busy, setBusy] = useState(false);

  const apply = (next: DemandInjection) => {
    setDraft(next);
    setBusy(true);
    void sendDebug({ type: 'debug:set-demand', state: next }).finally(() => setBusy(false));
  };

  const field = (key: 'dealId' | 'steamTradeId' | 'proveAfter', label: string, hint: string) => (
    <label class="muted demand-field">
      {label}
      <input
        type="text"
        value={draft[key]}
        placeholder={hint}
        // Typing does not arm anything: the value is applied on blur, so a half-typed deal id never
        // reaches the wrap and a partially-filled mark is refused by `isDemandArmed` regardless.
        onInput={(e) => setDraft({ ...draft, [key]: (e.target as HTMLInputElement).value.trim() })}
        onBlur={() => apply(draft)}
      />
    </label>
  );

  return (
    // Collapsed by default, and a `details`/`summary` like every other storage row — as a bare `div` it had
    // neither the row padding (`.store-row > summary`) nor a way to fold away, so the one pinned row nobody
    // touches in a normal session was also the only one shouting. The ARMED pill lives in the summary, so a
    // standing mark is still visible while the row is shut.
    <details class="store-row">
      <summary>
        <span class="store-key">{DEMAND_KEY}</span>
        <span class={`pill ${isDemandArmed(draft) ? 'on' : ''}`}>{isDemandArmed(draft) ? 'ARMED' : 'off'}</span>
        <span class="muted">freshness mark</span>
      </summary>
      <div class="store-body">
        <div class="demand-body">
          <label class="muted sim-master">
            <input type="checkbox" checked={draft.enabled} disabled={busy} onChange={() => apply({ ...draft, enabled: !draft.enabled })} />
            stamp a freshness mark on the next heartbeat
          </label>
          {field('dealId', 'deal', 'a deal THIS heartbeat already tracks')}
          {field('steamTradeId', 'steam trade id', 'a REAL tradeid — read it off the offer snapshot')}
          {field('proveAfter', 'prove after', '2026-09-02T10:15:30Z')}
          <button
            disabled={busy}
            onClick={() => apply({ ...draft, proveAfter: new Date().toISOString().replace(/\.\d+Z$/, 'Z') })}
          >
            use now
          </button>
          <p class="muted">
            Reproduces what the backend does when a protection hold expires: it stamps this mark on the
            deal&apos;s watch entry and releases the payout only against a proof attested at or after it. There
            is no other way to reach that code path by hand — every earlier lever (deleting an accepted-proof
            row, force tick) drives the <em>change</em>-detected path instead, which is a different branch.
          </p>
          <p class="muted">
            The instant is stored, not recomputed per heartbeat — a mark derived from <code>now</code> each time
            would be greater every time, so the core&apos;s monotone latch could never hold and the deal would
            re-prove on every wake. It is answered <strong>once</strong>; press <em>use now</em> again to ask
            again. The trade id must be real: a fabricated one makes the proven read answer for nothing and the
            proof dies inside MPC, where the failure is opaque.
          </p>
        </div>
        <pre>{typeof value === 'string' ? value : '(no standing recorded yet)'}</pre>
      </div>
    </details>
  );
}
