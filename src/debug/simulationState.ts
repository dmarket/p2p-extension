// The blocking-state simulator's own vocabulary and its persisted shape — the pure half, with ZERO
// runtime imports.
//
// Split from src/debug/simulate.ts (which installs the fetch rails and needs the settings snapshot and
// the session log) so that two other readers can have the types and the parser without dragging any of
// that in: the debug PAGE, which renders the checkboxes, and src/debug/blockingStates.ts, which is
// bundled and executed by scripts/check-surface-priority.mjs in node. Same reasoning as
// src/core/blockingReason.ts's header.
//
// Dev-only, like everything under src/debug/.

/**
 * A simulated cause. Each id names the CONDITION that is reproduced, never the state that results —
 * the whole point is that the core resolves the state itself (see src/debug/simulate.ts for how each
 * one is produced, and src/debug/blockingStates.ts for which state it lands on).
 *
 * The chain's fourth state, `NOT_ACTIVATED`, is deliberately absent: it is the host's own flag, so there
 * is nothing to simulate. Its row in the panel toggles `activation.enabled` itself, which also means
 * there is no "value before the simulation" to remember and restore.
 */
export type ScenarioId =
  | 'dm-session-missing'
  | 'steam-session-missing'
  | 'steam-account-mismatch'
  | 'dm-connection-error';

/** Every scenario, for validating a stored value. */
export const SCENARIO_IDS: readonly ScenarioId[] = [
  'dm-session-missing',
  'steam-session-missing',
  'steam-account-mismatch',
  'dm-connection-error',
];

/**
 * What is armed. [enabled] is the master switch: it is kept separate from an empty [scenarios] list so
 * that switching the simulator off and back on restores the previous selection instead of clearing it.
 */
export interface SimulationState {
  enabled: boolean;
  scenarios: ScenarioId[];
}

/** Nothing simulated — the value every failed parse falls back to. */
export const DISARMED: SimulationState = { enabled: false, scenarios: [] };

/** chrome.storage.local key holding the simulation state (dev-only, re-read on every worker spawn). */
export const SIMULATION_KEY = 'debug.simulation';

/**
 * Read a stored value into a {@link SimulationState}. Fails safe to {@link DISARMED} on anything
 * unexpected — a half-written or hand-edited key must never leave the extension lying about its state,
 * and unknown scenario ids (a value written by a newer build) are dropped rather than carried.
 */
export function parseSimulation(raw: unknown): SimulationState {
  if (typeof raw !== 'object' || raw === null) return DISARMED;
  const { enabled, scenarios } = raw as { enabled?: unknown; scenarios?: unknown };
  if (enabled !== true && enabled !== false) return DISARMED;
  if (!Array.isArray(scenarios)) return DISARMED;
  const known = scenarios.filter((s): s is ScenarioId => SCENARIO_IDS.includes(s as ScenarioId));
  return { enabled, scenarios: [...new Set(known)] };
}

/** Whether [id] is actually in effect — armed AND the master switch on. */
export function isArmed(state: SimulationState, id: ScenarioId): boolean {
  return state.enabled && state.scenarios.includes(id);
}

/** The scenarios actually in effect (empty when the master switch is off). */
export function armedScenarios(state: SimulationState): ScenarioId[] {
  return state.enabled ? state.scenarios : [];
}
