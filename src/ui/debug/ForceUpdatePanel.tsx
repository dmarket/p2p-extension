// The forced-update minimum override (DEV only), pinned in the storage panel. It replaces the published
// `web.minExtensionVersion` (src/config/settings.ts, `withDevMinVersion`), so the worker runs the real
// forced-update path — `requestUpdateCheck()`, then `restart_required` on an unpacked build that has no update
// to find — and the popup shows "Update required", all without publishing a minimum to stage.

import { useEffect, useState } from 'preact/hooks';

import { DEV_MIN_VERSION_KEY } from '@/config/settings';
import { useUpdateStatus } from '@/ui/hooks/useUpdateStatus';
import { extensionVersion } from '@/util/extensionVersion';
import { isChromeVersion, numericVersion } from '@/util/version';

/** One past this build: the smallest minimum that makes it outdated. */
function nextVersion(): string {
  const parts = numericVersion(extensionVersion()).split('.').map(Number);
  parts[parts.length - 1] = (parts[parts.length - 1] ?? 0) + 1;
  return parts.join('.');
}

export function ForceUpdatePanel({ value }: { value?: unknown }): preact.JSX.Element {
  const [draft, setDraft] = useState('');
  const status = useUpdateStatus();
  useEffect(() => setDraft(typeof value === 'string' ? value : ''), [value]);

  const apply = (next: string) => {
    if (next === '') void browser.storage.local.remove(DEV_MIN_VERSION_KEY);
    else if (isChromeVersion(next)) void browser.storage.local.set({ [DEV_MIN_VERSION_KEY]: next });
  };
  const armed = typeof value === 'string';

  return (
    <details class="store-row">
      <summary>
        <span class="store-key">{DEV_MIN_VERSION_KEY}</span>
        <span class={`pill ${armed ? 'on' : ''}`}>{armed ? value : 'off'}</span>
        <span class="muted">forced update{status ? `: ${status.required ? status.state : 'not required'}` : ''}</span>
      </summary>
      <div class="store-body">
        <div class="demand-body">
          <label class="muted demand-field">
            minimum version
            <input
              type="text"
              value={draft}
              placeholder="published minimum"
              onInput={(e) => setDraft((e.target as HTMLInputElement).value.trim())}
              onBlur={() => apply(draft)}
            />
          </label>
          <button onClick={() => apply(nextVersion())}>require {nextVersion()}</button>
          <button disabled={!armed} onClick={() => apply('')}>
            clear
          </button>
          <p class="muted">
            Replaces the published minimum on this install. Above this build&apos;s own version ({extensionVersion()}),
            the worker asks Chrome for the update, finds none on an unpacked build and settles on
            restart_required: the popup shows &quot;Update required&quot; and the presence pong says the same. A
            numeric version only (1.0.7, never 1.0.7-beta).
          </p>
        </div>
      </div>
    </details>
  );
}
