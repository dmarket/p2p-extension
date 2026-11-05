import { isActivated, subscribeActivation } from '@/state/activation';
import { getBlockingReason, subscribeBlockingReason, type BlockingReason } from '@/state/blocking';
import { resolveSurface } from '@/state/surface';
import { liveVerdicts, readVerdicts } from '@/background/offerGuard';
import type { OfferVerdicts } from '@/state/offerGuard';
import { subscribeVerdicts } from '@/state/verdicts';
import { getUpdateStatus, showsUpdateLayer, subscribeUpdateStatus, type UpdateStatus } from '@/state/updateStatus';

// Toolbar icon: three glyphs, chosen through the SAME precedence the popup and the Steam banner use
// (state/surface.ts), so the icon always matches the screen the popup would show:
//   - "blocked"  (red glyph)   — any sign-in problem (no DMarket session, no Steam session, wrong Steam
//                                account), or — once activated — a DMarket server error or a reason this
//                                build doesn't recognise.
//   - "inactive" (grey glyph)  — not activated, and nothing above it blocking.
//   - "active"   (green glyph) — activated and nothing blocking.
// On top, the forced-update layer (state/updateStatus.ts `showsUpdateLayer`, shared with the popup) replaces the
// last three with the grey glyph and an orange "!" badge, exactly when the popup shows "Update required".
// The inactive set (`public/icon/*.png`) is the manifest's `action.default_icon`, so a fresh,
// not-yet-activated install shows it before any JS runs; the other two sets live under
// `public/icon/{active,mismatch}/`. The manifest `icons` (extensions page, install dialog) is the
// active set, set in wxt.config.ts.

const INACTIVE_ICON = {
  16: 'icon/16.png',
  32: 'icon/32.png',
  48: 'icon/48.png',
  128: 'icon/128.png',
};

const ACTIVE_ICON = {
  16: 'icon/active/16.png',
  32: 'icon/active/32.png',
  48: 'icon/active/48.png',
  128: 'icon/active/128.png',
};

// Reused for any blocked state (wrong Steam account or no DMarket connection) — one red glyph, no
// per-reason assets.
const BLOCKED_ICON = {
  16: 'icon/mismatch/16.png',
  32: 'icon/mismatch/32.png',
  48: 'icon/mismatch/48.png',
  128: 'icon/mismatch/128.png',
};

// The blocking reason comes from PERSISTED state (state/blocking.ts), not an in-memory flag: MV3 kills
// and respawns the service worker constantly, and an in-memory flag would reset on every respawn —
// painting the icon green until the next heartbeat corrected it. Reading persisted state on boot makes
// the icon correct immediately on every spawn. This mirror is re-seeded from storage in initIcon() and
// kept live by subscribeBlockingReason().
let reason: BlockingReason = 'NONE';
let update: UpdateStatus<string> = { required: false, state: 'none' };
// What the badge shows; each is set by its own source and the badge is painted from both.
let flagged = false;
let updateShown = false;

// The orange of the popup's "Update required" screen (src/assets/icons/badge-update.svg, warning-amber.svg).
const UPDATE_BADGE = { background: '#FF9634', text: '#0F0F10' };
const OFFER_BADGE = { background: '#e5484d', text: '#FFFFFF' };

async function applyIcon(): Promise<void> {
  try {
    // One resolver for all three surfaces — a per-surface copy of the priority is how the icon came to
    // disagree with the popup. `LOADING` is unreachable here: both inputs are always resolved values.
    const surface = resolveSurface(await isActivated(), reason);
    updateShown = showsUpdateLayer(update, surface);
    const path =
      updateShown || surface === 'NOT_ACTIVATED' ? INACTIVE_ICON : surface === 'ACTIVE' ? ACTIVE_ICON : BLOCKED_ICON;
    await browser.action.setIcon({ path });
    await paintBadge();
  } catch (error) {
    console.debug('[dmarket-p2p] icon update failed', error);
  }
}

// The badge is one "!" slot, two meanings:
//   - red    — a suspicious outgoing Steam offer is cached (src/background/offerGuard.ts). It wins in every state,
//              because an offer waiting for a mobile confirmation matters more than anything else here, and goes
//              once the offer leaves the sent page, the user trusts the partner, or the cache expires;
//   - orange — the popup shows "Update required" (on the grey glyph, as for a not-activated install).
async function applyBadge(verdicts: OfferVerdicts | Promise<OfferVerdicts> = readVerdicts()): Promise<void> {
  try {
    flagged = Object.keys(await verdicts).length > 0;
    await paintBadge();
  } catch (error) {
    console.debug('[dmarket-p2p] badge update failed', error);
  }
}

async function paintBadge(): Promise<void> {
  const colors = flagged ? OFFER_BADGE : UPDATE_BADGE;
  await browser.action.setBadgeBackgroundColor({ color: colors.background });
  // Chrome 110+; the manifest sets no minimum Chrome, and an older one must still get the badge itself.
  await browser.action.setBadgeTextColor?.({ color: colors.text });
  await browser.action.setBadgeText({ text: flagged || updateShown ? '!' : '' });
}

/**
 * Reflect the activation flag, the tracker's blocking reason and the forced-update status on the toolbar icon,
 * and keep them in sync. Call once, synchronously, on every service-worker spawn: it seeds the icon from stored
 * state and subscribes to changes in any of the three.
 */
export function initIcon(): void {
  // Seed the reason from persisted state before painting so a respawn doesn't flash the wrong glyph.
  void Promise.all([getBlockingReason(), getUpdateStatus()]).then(([r, u]) => {
    reason = r;
    update = u;
    return applyIcon();
  });
  subscribeActivation(() => void applyIcon());
  subscribeBlockingReason((r) => {
    reason = r;
    void applyIcon();
  });
  subscribeUpdateStatus((u) => {
    update = u;
    void applyIcon();
  });
  void applyBadge();
  subscribeVerdicts((v) => void applyBadge(liveVerdicts(v)));
}
