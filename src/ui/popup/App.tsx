import { useEffect, useRef, useState } from 'preact/hooks';
import { resolveSurface } from '@/state/surface';
import { useActivation } from '@/ui/hooks/useActivation';
import { useBlockingReason } from '@/ui/hooks/useBlockingReason';
import { useUpdateStatus } from '@/ui/hooks/useUpdateStatus';
import { useVerdicts } from '@/ui/hooks/useVerdicts';
import { showsUpdateLayer } from '@/state/updateStatus';
import { Header, type Tab } from './Header';
import { InactiveScreen } from './screens/InactiveScreen';
import { ActiveScreen } from './screens/ActiveScreen';
import { MismatchScreen } from './screens/MismatchScreen';
import { MissingConnectionScreen } from './screens/MissingConnectionScreen';
import { ConnectionErrorScreen } from './screens/ConnectionErrorScreen';
import { SteamSignedOutScreen } from './screens/SteamSignedOutScreen';
import { UpdateRequiredScreen } from './screens/UpdateRequiredScreen';
import { HowToUpdateView } from './screens/HowToUpdateView';
import { InfoScreen } from './screens/InfoScreen';
import { SuspiciousOffersRow } from './SuspiciousOffersRow';

export function App() {
  const [tab, setTab] = useState<Tab>('home');
  const activated = useActivation();
  const reason = useBlockingReason();
  const verdicts = useVerdicts();
  const update = useUpdateStatus();
  const [howTo, setHowTo] = useState(false);
  const howToLinkRef = useRef<HTMLButtonElement>(null);
  const returnedRef = useRef(false);

  // Back from "How to update" lands on the link that opened it, as Back from the log export does.
  useEffect(() => {
    if (!howTo && returnedRef.current) {
      returnedRef.current = false;
      howToLinkRef.current?.focus();
    }
  }, [howTo]);

  // No "re-check now" nudge on open (an earlier design forced a heartbeat per popup view): the
  // persisted blocking reason is kept truthful without it — blocked states never advance the
  // heartbeat schedule, so the core re-evaluates them on its ~minutely alarm wakes regardless of the
  // popup; a DMarket logout/login is caught reactively by the cookie watch (background/refresh.ts);
  // everything else waits for the backend-ttl tick or an explicit debug force-tick. Heartbeats stay
  // schedule/event-driven, never view-driven.

  // Home tab: exactly one screen, chosen by the shared precedence in state/surface.ts (the same one the
  // toolbar icon and the Steam banner use — see that module for the order and why it is what it is).
  // `LOADING` must stay a VISIBLE placeholder, not null: the popup is black-on-black, so an empty home
  // screen is indistinguishable from a popup that failed to open when the storage reads lag behind a cold
  // worker start. `BLOCKED` is the fail-closed bucket (a DMarket server error, or a reason this build does
  // not recognise) and gets the neutral "paused" surface rather than ActiveScreen. The first verdict read is
  // waited for too, so the warning row and the screen under it paint in one frame.
  const surface = verdicts === undefined || update === undefined ? 'LOADING' : resolveSurface(activated, reason);
  // Forced update: a layer over the shared precedence, shared with the toolbar icon (the Steam banner keeps its
  // own). Activating or carrying on with an outdated build is what the update is there to stop; in-progress
  // trades keep being tracked meanwhile.
  const updateScreen = update !== undefined && showsUpdateLayer(update, surface);
  const homeScreen = ((): preact.JSX.Element => {
    if (updateScreen) {
      if (howTo) {
        return (
          <HowToUpdateView
            onBack={() => {
              returnedRef.current = true;
              setHowTo(false);
            }}
          />
        );
      }
      return <UpdateRequiredScreen linkRef={howToLinkRef} onHowToUpdate={() => setHowTo(true)} />;
    }
    switch (surface) {
      case 'LOADING':
        return (
          <div class="screen-loading" aria-busy="true">
            <div class="screen-loading__spinner" />
          </div>
        );
      case 'DM_SESSION_MISSING':
        return <MissingConnectionScreen />;
      case 'STEAM_SESSION_MISSING':
        return <SteamSignedOutScreen />;
      case 'STEAM_ACCOUNT_MISMATCH':
        return <MismatchScreen />;
      case 'NOT_ACTIVATED':
        return <InactiveScreen />;
      case 'BLOCKED':
        return <ConnectionErrorScreen />;
      case 'ACTIVE':
        return <ActiveScreen />;
    }
  })();

  return (
    <div class="app">
      <Header
        tab={tab}
        onSelect={(next) => {
          // Leaving Home closes "How to update", as leaving Help closes the log export.
          setHowTo(false);
          setTab(next);
        }}
      />
      <div class="screen">
        {/* "How to update" is a full sub-view: the warning row stays on the screens, not over the instructions. */}
        {tab === 'home' && surface !== 'LOADING' && verdicts !== undefined && !(updateScreen && howTo) && (
          <SuspiciousOffersRow verdicts={verdicts} />
        )}
        {tab === 'help' ? <InfoScreen /> : homeScreen}
      </div>
    </div>
  );
}
