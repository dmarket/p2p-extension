// The tracker's single prioritized blocking reason — the one thing that stops the tracker from
// working right now (no Steam session, no DMarket connection, wrong Steam account, or nothing).
//
// The core resolves the priority per heartbeat (`blockingReason()`, see src/core/tracker.ts); the
// background persists the resolved value here so every UI surface (popup, Steam on-page banner,
// toolbar icon) reacts to it the same way it reacts to the activation flag. The client NEVER
// recomputes the priority among these reasons — it only mirrors what the core reported; the one thing
// it does decide is where the host-owned activation flag sits relative to them (state/surface.ts).
// Persisting (rather than pushing to a tab) means the state survives service-worker respawns and is
// correct even when a tab is opened after the block was detected. It auto-clears the moment a later
// heartbeat reports `NONE`.

import { normalizeBlockingReason, type BlockingReason } from '@/core/blockingReason';
import { subscribeKey } from '@/state/subscribeKey';

export type { BlockingReason } from '@/core/blockingReason';

/** Exported for the dev console's storage inspector, which renders this one key as its own panel. */
export const BLOCKING_KEY = 'tracker.blockingReason';

/**
 * The DMarket-linked Steam id the core reported alongside a wrong-account block — the account the user
 * must sign into. Persisted next to the reason (not derived from it) because the core only names it in the
 * `LinkedSteamIdMismatch` lifecycle event, which a popup opened later never sees.
 *
 * It is the user's OWN linked account, so surfacing it is what turns an un-actionable "wrong account"
 * prompt into a fixable one — and it is the one thing that distinguishes a stale verdict from a truthful
 * one (a profile genuinely linked to a different account) without a debug console. The id of whoever else
 * is signed into the browser is deliberately never stored or shown.
 */
const LINKED_STEAM_ID_KEY = 'tracker.linkedSteamId';

/**
 * Recognise a stored value through the seam's single allow-list — deliberately NOT a second copy of it.
 * Absent/blank reads as `NONE`; an unrecognised reason (a newer core, or a hand-edited value in the
 * debug console) reads as `UNKNOWN`, which every surface renders as blocked. The raw core name is what
 * gets stored, so the debug console still shows exactly what the core said.
 */
const parse = normalizeBlockingReason;

/** Read the current blocking reason. Absent counts as `NONE`, unrecognised as `UNKNOWN`. */
export async function getBlockingReason(): Promise<BlockingReason> {
  const stored = await browser.storage.local.get(BLOCKING_KEY);
  return parse(stored[BLOCKING_KEY]);
}

/**
 * Persist the blocking reason. Read-compare-write: only writes when the value actually changes, so the
 * frequent callers (every heartbeat event, every presence poll) don't fire a `storage.onChanged` storm.
 */
export async function setBlockingReason(reason: BlockingReason): Promise<void> {
  const current = await getBlockingReason();
  if (current === reason) return;
  await browser.storage.local.set({ [BLOCKING_KEY]: reason });
}

/**
 * Subscribe to blocking-reason changes across contexts (content scripts, background). Returns an
 * unsubscribe function.
 */
export function subscribeBlockingReason(onChange: (reason: BlockingReason) => void): () => void {
  return subscribeKey('local', BLOCKING_KEY, parse, onChange);
}

/** Absent, blank or non-string reads as "no id known" — the surfaces fall back to generic copy. */
const parseSteamId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Read the DMarket-linked Steam id from the last wrong-account report, or `undefined` if none is known. */
export async function getLinkedSteamId(): Promise<string | undefined> {
  const stored = await browser.storage.local.get(LINKED_STEAM_ID_KEY);
  return parseSteamId(stored[LINKED_STEAM_ID_KEY]);
}

/**
 * Persist (or clear, with `undefined`) the linked Steam id. Read-compare-write like the reason itself, so
 * the per-cycle callers write nothing when it is unchanged.
 */
export async function setLinkedSteamId(steamId: string | undefined): Promise<void> {
  const current = await getLinkedSteamId();
  if (current === steamId) return;
  if (steamId === undefined) {
    await browser.storage.local.remove(LINKED_STEAM_ID_KEY);
  } else {
    await browser.storage.local.set({ [LINKED_STEAM_ID_KEY]: steamId });
  }
}

/** Subscribe to linked-Steam-id changes across contexts. Returns an unsubscribe function. */
export function subscribeLinkedSteamId(onChange: (steamId: string | undefined) => void): () => void {
  return subscribeKey('local', LINKED_STEAM_ID_KEY, parseSteamId, onChange);
}
