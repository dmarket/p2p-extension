// Side-effect module: installs the popup's global error hooks at module-evaluation time.
//
// Imported as the FIRST line of src/entrypoints/popup/main.tsx, above the font CSS and `App`, so a throw
// while those evaluate is still reported. Reports RELAY to the service worker rather than being POSTed
// here: every popup CTA calls `browser.tabs.create`, which destroys the popup document and with it any
// in-flight request.
//
// See install.ts for why this graph is kept dependency-light.

import { installGlobalHandlers } from '@/infra/report/reporter';

installGlobalHandlers('popup');
