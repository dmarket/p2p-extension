// The freshness-mark injector's vocabulary and persisted shape — the pure half, with ZERO runtime imports.
//
// Split from src/debug/simulate.ts (which owns the fetch wrap) for the same reason
// src/debug/simulationState.ts is: the debug PAGE renders the form and must not drag the settings snapshot
// and the session log in with it.
//
// Dev-only, like everything under src/debug/.
//
// WHAT THIS IS FOR. DMA-280's client trigger fires on a `proveAfter` mark the BACKEND stamps on a deal's
// watch entry when its protection hold expires. There is no other way to reach that code path by hand: the
// mark is not something the client can arm, and every earlier lever an operator had (deleting a
// `tracker_accepted_proofs` row, force tick) reaches the CHANGE-detected path instead — which is a different
// branch answering a different question. So without this, "does the demand path work in a real browser, with
// real storage and a real MPC session?" is answerable only from a full harness stand.
//
// WHAT IT IS DELIBERATELY NOT. Not a `ScenarioId` and not a row in the blocking-state chain. A demand is not
// a blocking state: it neither blocks the tracker nor changes what any surface shows, and
// `scripts/check-surface-priority.mjs` would reject a catalog row whose reason is not in the chain — while a
// scenario id with no row would make `simulatedReason()` claim `NONE` and override a REAL block. Its own
// key, its own command, its own panel section.

/**
 * A hand-stamped freshness mark: which deal, which Steam trade, and the instant to beat.
 *
 * All three are explicit, and [proveAfter] in particular is stored rather than computed at stamp time. A mark
 * derived from `now` on each heartbeat would be strictly greater every time, so the client's monotone latch
 * could never hold and the deal would re-prove on every wake — reproducing, with a dev tool, the exact
 * runaway the latch exists to prevent. The operator arms one instant and the injector keeps stamping it.
 *
 * [steamTradeId] must be a **real** Steam `tradeid` for this deal — read it off the offer snapshot in the
 * session log. A fabricated one makes the proven read (`GetTradeStatus?tradeid=…`) answer for nothing, and
 * the proof then dies inside MPC where the failure is opaque.
 */
export interface DemandInjection {
  enabled: boolean;
  dealId: string;
  steamTradeId: string;
  /** RFC3339, as the backend would send it. */
  proveAfter: string;
}

/** Nothing injected — the value every failed parse falls back to. */
export const NO_DEMAND: DemandInjection = { enabled: false, dealId: '', steamTradeId: '', proveAfter: '' };

/** chrome.storage.local key holding the injected mark (dev-only, re-read on every worker spawn). */
export const DEMAND_KEY = 'debug.demand';

/**
 * Read a stored value into a {@link DemandInjection}. Fails safe to {@link NO_DEMAND}: a half-written or
 * hand-edited key must never leave the injector stamping something it cannot describe.
 */
export function parseDemand(raw: unknown): DemandInjection {
  if (typeof raw !== 'object' || raw === null) return NO_DEMAND;
  const { enabled, dealId, steamTradeId, proveAfter } = raw as Record<string, unknown>;
  if (enabled !== true && enabled !== false) return NO_DEMAND;
  if (typeof dealId !== 'string' || typeof steamTradeId !== 'string' || typeof proveAfter !== 'string') {
    return NO_DEMAND;
  }
  return { enabled, dealId, steamTradeId, proveAfter };
}

/**
 * Whether this injection is actually in effect: armed, and complete enough to stamp.
 *
 * The completeness half is not cosmetic. A mark with no trade id is a state the CORE has to handle (it
 * reports it as unbindable and nobody can answer it), but there is no reason for a dev tool to manufacture
 * it — an operator who has not finished filling the form has not asked for anything yet, and stamping a
 * half-filled mark would produce a `ProofSuppressed` they would then have to diagnose.
 */
export function isDemandArmed(state: DemandInjection): boolean {
  return state.enabled && state.dealId !== '' && state.steamTradeId !== '' && state.proveAfter !== '';
}
