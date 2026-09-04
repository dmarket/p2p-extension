import { useState } from 'preact/hooks';
import { setActivated } from '@/state/activation';
import { resolveSurface } from '@/state/surface';
import { useActivation } from '@/ui/hooks/useActivation';
import { useBlockingReason } from '@/ui/hooks/useBlockingReason';
import { Banner } from './Banner';
import { RulesModal } from './RulesModal';
import { SuccessModal } from './SuccessModal';
import { ActiveBanner } from './ActiveBanner';
import { MismatchBanner } from './MismatchBanner';

type Step = 'idle' | 'rules' | 'success';

/**
 * The persistent Steam trade-offers UI, driven reactively by the shared activation flag and the core's
 * single blocking reason through the same precedence every other surface uses (state/surface.ts):
 *   - wrong Steam account -> "Wrong Steam account" banner (Switch account -> Steam logout). Shown even
 *     before onboarding: activating on the wrong account would track nothing.
 *   - any other block     -> no banner. Its prompt lives in the popup, and for a missing DMarket/Steam
 *     session this page is only reachable in a stale tab anyway. Unrecognised reasons land here too
 *     (fail closed) rather than claiming tracking is on.
 *   - not activated       -> onboarding banner -> rules modal -> success modal
 *   - nothing blocking    -> "Trade tracking is ON" banner
 */
export function SteamApp() {
  // Both are `undefined` until their first read resolves — NOT an optimistic `false`/'NONE', which
  // flashed the "Trade tracking is ON" banner on every page load regardless of the real state.
  const activated = useActivation();
  const reason = useBlockingReason();
  const [step, setStep] = useState<Step>('idle');

  const confirm = async (): Promise<void> => {
    await setActivated(true);
    setStep('success');
  };

  switch (resolveSurface(activated, reason)) {
    // Avoid flashing a banner before the initial activation / blocking reads resolve.
    case 'LOADING':
      return null;
    case 'STEAM_ACCOUNT_MISMATCH':
      return <MismatchBanner />;
    case 'DM_SESSION_MISSING':
    case 'STEAM_SESSION_MISSING':
    case 'BLOCKED':
      return null;
    case 'NOT_ACTIVATED':
      return (
        <>
          <Banner onActivate={() => setStep('rules')} />
          {/* `void confirm()` rather than passing the async function straight in: the prop is typed to
              return void, so a rejection would be dropped on the floor by the caller. */}
          {step === 'rules' && (
            <RulesModal onClose={() => setStep('idle')} onConfirm={() => void confirm()} />
          )}
        </>
      );
    case 'ACTIVE':
      return (
        <>
          <ActiveBanner />
          {step === 'success' && <SuccessModal onClose={() => setStep('idle')} />}
        </>
      );
  }
}
