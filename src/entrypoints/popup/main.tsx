// FIRST import: installs the popup's global error hooks before the font CSS and App below evaluate.
import '@/infra/report/install-page';
import { render } from 'preact';
import '@fontsource/squada-one/latin-400.css';
import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/latin-500.css';
import '@fontsource/montserrat/latin-600.css';
import '@fontsource/montserrat/latin-700.css';
import '@/ui/popup/popup.css';
import { App } from '@/ui/popup/App';
import { initSettings } from '@/config/settings';

// Load the remote-config snapshot (and keep it live) so the screens' tab-open targets reflect any
// override. No-op-safe: defaults (the shipped URLs) apply until the async cache read resolves.
initSettings();

const root = document.getElementById('app');
// Drop index.html's paint-before-JS loading state (see the comment there) before the first render, so
// Preact never has to reconcile against a tree it did not produce.
document.getElementById('boot')?.remove();
if (root) render(<App />, root);
