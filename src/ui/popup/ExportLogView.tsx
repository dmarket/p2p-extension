import { useEffect, useRef, useState } from 'preact/hooks';
import { buildDiagExport, serializeDiagExport } from '@/infra/diag/export';
import { icons } from './icons';

interface ExportLogViewProps {
  onBack: () => void;
}

/** Last resort for a context where the async Clipboard API is refused. Synchronous, so it keeps the click's activation. */
function copyWithTextarea(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } finally {
    area.remove();
  }
}

/**
 * Help tab → Troubleshooting: the consent text for the support export, and the two ways to take it.
 *
 * The list below is the disclosure, so it must name everything src/infra/diag/export.ts writes — a header
 * field added there is added here, and in the store listing and privacy policy that make the same claim.
 *
 * "Save file" opens export.html in a tab instead of downloading from here: the popup closes the moment
 * focus leaves it, which would take a "Save as" dialog and the object URL down with it.
 */
export function ExportLogView({ onBack }: ExportLogViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState('');

  useEffect(() => headingRef.current?.focus(), []);

  const copy = async (): Promise<void> => {
    try {
      const text = serializeDiagExport(await buildDiagExport());
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        if (!copyWithTextarea(text)) throw new Error('copy refused');
      }
      setStatus('Copied. Paste it into your message to support.');
    } catch {
      setStatus("Couldn't copy. Use Save file instead.");
    }
  };

  return (
    <div class="export">
      <button type="button" class="link-button export__back" onClick={onBack}>
        ‹ Back
      </button>

      <h2 class="export__title" ref={headingRef} tabIndex={-1}>
        Export log for support
      </h2>
      <p class="export__text">
        Creates a file with recent activity from this extension, so DMarket support can see what went wrong.
      </p>

      <div class="export__warning">
        <img class="export__warning-icon" src={icons.warning} alt="" />
        <div>
          <p>
            This file contains your Steam ID, your DMarket account ID and your deal IDs. It's saved on your
            computer only and shared only if you send it yourself.
          </p>
          <p>It doesn't contain passwords, cookies or login tokens.</p>
        </div>
      </div>

      <div>
        <h3 class="export__subtitle">What's inside</h3>
        <ul class="export__list">
          <li>Versions of the extension, core and prover, and your browser</li>
          <li>Current status and the last 24 hours of activity</li>
          <li>Your Steam ID, DMarket account ID, deal and trade offer IDs</li>
          <li>A random install ID that links this file to error reports</li>
        </ul>
      </div>

      <p class="export__status" role="status" aria-live="polite">
        {status}
      </p>

      <button
        type="button"
        class="button"
        onClick={() => void browser.tabs.create({ url: browser.runtime.getURL('/export.html') })}
      >
        Save file
      </button>
      <button type="button" class="link-button export__copy" onClick={() => void copy()}>
        Copy to clipboard
      </button>
    </div>
  );
}
