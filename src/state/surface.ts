// The ONE place the extension decides which state a user-facing surface should show.
//
// Three surfaces render from the same two inputs — the popup home screen (ui/popup/App.tsx), the Steam
// on-page banner (ui/steam/SteamApp.tsx) and the toolbar icon (background/icon.ts). Each used to spell
// the priority out for itself, which is exactly how they drift: one of them ranked the activation prompt
// above every block, another ranked it below only one of them, and the icon could disagree with the
// screen the popup was about to show. They all call {@link resolveSurface} now.
//
// The order is the product decision, and it is guarded by scripts/check-surface-priority.mjs (run by
// `npm run compile`) so it cannot be changed by accident in a later session:
//
//   1. no DMarket session          -> DM_SESSION_MISSING      (sign into DMarket)
//   2. no Steam session            -> STEAM_SESSION_MISSING   (sign into Steam)
//   3. wrong Steam account         -> STEAM_ACCOUNT_MISMATCH  (switch to the linked account)
//   4. extension not activated     -> NOT_ACTIVATED           (onboarding)
//   5. anything else blocking      -> BLOCKED                 (neutral "paused" surface)
//   6. nothing                     -> ACTIVE
//
// Steps 1-3 outrank onboarding on purpose: all three are sign-in problems the user must fix first, and
// two of them make onboarding itself impossible (the Steam rules flow needs a Steam login, and activating
// on the wrong Steam account tracks nothing). Step 5 is last because it is the only state the user cannot
// act on — see the core's `BlockingState` for the matching precedence on the tracker side, which is what
// decides WHICH single reason reaches us.

import type { BlockingReason } from '@/core/blockingReason';

/**
 * What a surface should show. Distinct from {@link BlockingReason}: it folds in the host-owned activation
 * flag, collapses every unactionable block into one `BLOCKED` case, and names the "still reading storage"
 * state that all three surfaces have to handle.
 */
export type SurfaceState =
  | 'LOADING'
  | 'DM_SESSION_MISSING'
  | 'STEAM_SESSION_MISSING'
  | 'STEAM_ACCOUNT_MISMATCH'
  | 'NOT_ACTIVATED'
  | 'BLOCKED'
  | 'ACTIVE';

/**
 * Resolve the single state to render.
 *
 * Both inputs are `undefined` while their storage read is in flight — that is `LOADING`, never a guessed
 * screen (the popup is black-on-black, so a surface held blank is indistinguishable from one that failed
 * to open).
 *
 * Fails closed twice over: an unrecognised core reason has already become `'UNKNOWN'` at the seam
 * (`normalizeBlockingReason`), and anything not explicitly named here lands in `BLOCKED` rather than
 * `ACTIVE` — a state this build has never heard of must not be rendered as "tracking is ON".
 */
export function resolveSurface(
  activated: boolean | undefined,
  reason: BlockingReason | undefined,
): SurfaceState {
  if (activated === undefined || reason === undefined) return 'LOADING';
  if (reason === 'DM_SESSION_MISSING') return 'DM_SESSION_MISSING';
  if (reason === 'STEAM_SESSION_MISSING') return 'STEAM_SESSION_MISSING';
  if (reason === 'STEAM_ACCOUNT_MISMATCH') return 'STEAM_ACCOUNT_MISMATCH';
  if (!activated) return 'NOT_ACTIVATED';
  if (reason !== 'NONE') return 'BLOCKED';
  return 'ACTIVE';
}
