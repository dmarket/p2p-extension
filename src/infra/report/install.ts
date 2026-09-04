// Side-effect module: installs the service worker's global error hooks at module-evaluation time.
//
// Imported as the FIRST line of src/entrypoints/background.ts, above `@/core/tracker`. ES modules evaluate
// their imports in order, so anything imported below this point — including the ~1.2 MB compiled core —
// evaluates with the handlers already attached. A top-level throw in the core's module body is otherwise
// completely unreported: WXT's background wrapper logs it and rethrows, and its logger is compiled out of
// production builds.
//
// Deliberately dependency-light: a crash inside the reporter's own import graph is unreportable by
// construction, so that graph is kept to `describe.ts` + `redact.ts`, neither of which touches the core,
// the settings overlay, or storage.

import { installGlobalHandlers } from '@/infra/report/reporter';

installGlobalHandlers('background');
