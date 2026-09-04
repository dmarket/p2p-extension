import { isActivated, subscribeActivation } from '@/state/activation';
import { getBlockingReason, subscribeBlockingReason, type BlockingReason } from '@/state/blocking';
import { resolveSurface } from '@/state/surface';

// Toolbar icon: three glyphs, chosen through the SAME precedence the popup and the Steam banner use
// (state/surface.ts), so the icon always matches the screen the popup would show:
//   - "blocked"  (red glyph)   — any sign-in problem (no DMarket session, no Steam session, wrong Steam
//                                account), or — once activated — a DMarket server error or a reason this
//                                build doesn't recognise.
//   - "inactive" (grey glyph)  — not activated, and nothing above it blocking.
//   - "active"   (green glyph) — activated and nothing blocking.
// The inactive set is the manifest default (`public/icon/*.png`), so a fresh, not-yet-activated
// install shows it before any JS runs; the other two sets live under `public/icon/{active,mismatch}/`.

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

async function applyIcon(): Promise<void> {
  try {
    // One resolver for all three surfaces — a per-surface copy of the priority is how the icon came to
    // disagree with the popup. `LOADING` is unreachable here: both inputs are always resolved values.
    const surface = resolveSurface(await isActivated(), reason);
    const path =
      surface === 'ACTIVE' ? ACTIVE_ICON : surface === 'NOT_ACTIVATED' ? INACTIVE_ICON : BLOCKED_ICON;
    await browser.action.setIcon({ path });
  } catch (error) {
    console.debug('[dmarket-p2p] icon update failed', error);
  }
}

/**
 * Reflect the activation flag and the tracker's blocking reason on the toolbar icon, and keep both in
 * sync. Call once, synchronously, on every service-worker spawn: it seeds the icon from stored state
 * (activation + blocking reason) and subscribes to changes in either.
 */
export function initIcon(): void {
  // Seed the reason from persisted state before painting so a respawn doesn't flash the wrong glyph.
  void getBlockingReason().then((r) => {
    reason = r;
    return applyIcon();
  });
  subscribeActivation(() => void applyIcon());
  subscribeBlockingReason((r) => {
    reason = r;
    void applyIcon();
  });
}
