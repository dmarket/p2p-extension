import { APP_NAME } from '@/constants';
import { icons } from './icons';

export type Tab = 'home' | 'help';

interface HeaderProps {
  tab: Tab;
  onSelect: (tab: Tab) => void;
}

/** Popup header: brand on the left, Home/Help tab switcher on the right with an active underline. */
export function Header({ tab, onSelect }: HeaderProps) {
  return (
    <header class="header">
      <button
        type="button"
        class="header__brand"
        onClick={() => onSelect('home')}
        aria-label={APP_NAME}
      >
        <img class="header__logo" src={icons.logo} alt="" />
        <span class="header__wordmark">{APP_NAME}</span>
      </button>
      {/* Dev-only entry to the debug console. Dropped from production (the guard is a compile-time
          constant, and debug.html does not exist in prod builds). */}
      {!import.meta.env.PROD && (
        <button
          type="button"
          class="debug-link"
          onClick={() =>
            // debug.html exists only in dev builds; getURL's typed PublicPath omits it in production,
            // so cast for this dev-only link (the button itself is guarded by !import.meta.env.PROD).
            void browser.tabs.create({
              url: (browser.runtime.getURL as (path: string) => string)('/debug.html'),
            })
          }
        >
          debug console
        </button>
      )}
      <nav class="header__tabs">
        <button
          type="button"
          class={tab === 'home' ? 'tab tab--active' : 'tab'}
          onClick={() => onSelect('home')}
          aria-label="Home"
          aria-current={tab === 'home' ? 'page' : undefined}
        >
          <img
            class="tab__icon"
            src={tab === 'home' ? icons.tabHomeActive : icons.tabHomeInactive}
            alt=""
          />
        </button>
        <button
          type="button"
          class={tab === 'help' ? 'tab tab--active' : 'tab'}
          onClick={() => onSelect('help')}
          aria-label="Help"
          aria-current={tab === 'help' ? 'page' : undefined}
        >
          <img
            class="tab__icon"
            src={tab === 'help' ? icons.tabHelpActive : icons.tabHelpInactive}
            alt=""
          />
        </button>
      </nav>
    </header>
  );
}
