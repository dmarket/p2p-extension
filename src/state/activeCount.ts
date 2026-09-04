// The tracker's live active-tracking count — the number of trades the core is currently watching
// (the size of the backend's `active_tracking[]`, refreshed each loop cycle).
//
// The background subscribes to the core's count (`Tracker.subscribeActiveTrackingCount`, see
// src/core/tracker.ts) and mirrors the value here so the popup's "Activity on DMarket" badge reflects
// it live across the SW/popup context boundary — the same mirror-into-storage pattern the activation
// flag and blocking reason use (src/state/{activation,blocking}.ts).
//
// Unlike those two, this lives in `session` (not `local`) storage: the count is transient runtime
// state that is only meaningful while a tracker is running. `session` survives service-worker
// respawns (so the popup reads the last value instantly even when the SW is asleep) but clears on
// browser restart, so we never surface a stale count from a previous session before the first
// heartbeat of the new one. Every fresh core handle reports `0` until its first cycle completes.

import { subscribeKey } from '@/state/subscribeKey';

const ACTIVE_COUNT_KEY = 'tracker.activeTrackingCount';

function parse(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Read the current active-tracking count. Absent/malformed counts as `0`. */
export async function getActiveTrackingCount(): Promise<number> {
  const stored = await browser.storage.session.get(ACTIVE_COUNT_KEY);
  return parse(stored[ACTIVE_COUNT_KEY]);
}

/**
 * Persist the active-tracking count. Read-compare-write: only writes when the value actually changes,
 * so the per-cycle callbacks don't fire a redundant `storage.onChanged` when the count is unchanged.
 */
export async function setActiveTrackingCount(count: number): Promise<void> {
  const next = parse(count);
  const current = await getActiveTrackingCount();
  if (current === next) return;
  await browser.storage.session.set({ [ACTIVE_COUNT_KEY]: next });
}

/**
 * Subscribe to active-tracking-count changes (popup ⇄ background). Returns an unsubscribe function.
 */
export function subscribeActiveTrackingCount(onChange: (count: number) => void): () => void {
  return subscribeKey('session', ACTIVE_COUNT_KEY, parse, onChange);
}
