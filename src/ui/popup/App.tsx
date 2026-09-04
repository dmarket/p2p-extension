import { useState } from 'preact/hooks';
import { resolveSurface } from '@/state/surface';
import { useActivation } from '@/ui/hooks/useActivation';
import { useBlockingReason } from '@/ui/hooks/useBlockingReason';
import { Header, type Tab } from './Header';
import { InactiveScreen } from './screens/InactiveScreen';
import { ActiveScreen } from './screens/ActiveScreen';
import { MismatchScreen } from './screens/MismatchScreen';
import { MissingConnectionScreen } from './screens/MissingConnectionScreen';
import { ConnectionErrorScreen } from './screens/ConnectionErrorScreen';
import { SteamSignedOutScreen } from './screens/SteamSignedOutScreen';
import { InfoScreen } from './screens/InfoScreen';

export function App() {
  const [tab, setTab] = useState<Tab>('home');
  const activated = useActivation();
  const reason = useBlockingReason();

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
  // not recognise) and gets the neutral "paused" surface rather than ActiveScreen.
  const homeScreen = ((): preact.JSX.Element => {
    switch (resolveSurface(activated, reason)) {
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
      <Header tab={tab} onSelect={setTab} />
      <div class="screen">
        {tab === 'help' ? <InfoScreen onClose={() => setTab('home')} /> : homeScreen}
      </div>
    </div>
  );
}
