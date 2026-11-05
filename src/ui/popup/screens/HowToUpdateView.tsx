import { useEffect, useRef, useState } from 'preact/hooks';
import { BackButton } from '../BackButton';
import { copyText } from '../clipboard';
import { icons } from '../icons';

const EXTENSIONS_URL = 'chrome://extensions';
// An extension can open chrome://extensions but never chrome://restart (Chromium refuses it as a "kill URL"),
// so the restart path is copy-and-paste only.
const RESTART_URL = 'chrome://restart';

/**
 * "Update required" → "How to update?": the two ways to get the update now. Without restarting comes first
 * because the extensions page opens in one click; the restart address can only be copied. Never suggests
 * removing or reinstalling the extension (DMA-482).
 */
export function HowToUpdateView({ onBack }: { onBack: () => void }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [openFailed, setOpenFailed] = useState(false);
  // Each copy button answers next to itself: the step-1 fallback and the restart section are far apart.
  const [extensionsStatus, setExtensionsStatus] = useState('');
  const [restartStatus, setRestartStatus] = useState('');

  useEffect(() => headingRef.current?.focus(), []);

  // A policy (URLBlocklist) or a browser without chrome:// pages can refuse the tab: fall back to copying.
  const openExtensions = (): void => {
    browser.tabs.create({ url: EXTENSIONS_URL }).catch(() => setOpenFailed(true));
  };

  const copy = async (url: string, setStatus: (text: string) => void): Promise<void> => {
    try {
      await copyText(url);
      setStatus(`Copied ${url}.`);
    } catch {
      setStatus(`Couldn't copy. Type ${url} into the address bar.`);
    }
  };

  const copyButton = (url: string, setStatus: (text: string) => void) => (
    <button type="button" class="how-to__address" aria-label={`Copy ${url}`} onClick={() => void copy(url, setStatus)}>
      {url}
      <img class="how-to__address-icon" src={icons.copy} alt="" />
    </button>
  );

  return (
    <div class="how-to">
      <BackButton onClick={onBack} />

      <section class="how-to__section how-to__section--divided">
        <h2 class="how-to__title" ref={headingRef} tabIndex={-1}>
          Update without restarting
        </h2>
        <ol class="how-to__steps">
          <li class="how-to__step">
            <span class="how-to__dot">1</span>
            <div class="how-to__step-body">
              <span>Open the extensions page:</span>
              <button type="button" class="how-to__address" aria-label={`Open ${EXTENSIONS_URL}`} onClick={openExtensions}>
                {EXTENSIONS_URL}
                <img class="how-to__address-icon" src={icons.openInNew} alt="" />
              </button>
              {openFailed && (
                <>
                  <span class="how-to__hint">Couldn't open it. Copy it and paste it into the address bar.</span>
                  {copyButton(EXTENSIONS_URL, setExtensionsStatus)}
                  <p class="how-to__status" role="status" aria-live="polite">
                    {extensionsStatus}
                  </p>
                </>
              )}
            </div>
          </li>
          <li class="how-to__step">
            <span class="how-to__dot">2</span>
            <div class="how-to__step-body">Turn on Developer mode.</div>
          </li>
          <li class="how-to__step">
            <span class="how-to__dot">3</span>
            <div class="how-to__step-body">Click Update.</div>
          </li>
        </ol>
      </section>

      <section class="how-to__section">
        <h2 class="how-to__title">Update and restart browser</h2>
        <p class="how-to__text">Copy and paste into the address bar and press Enter.</p>
        {copyButton(RESTART_URL, setRestartStatus)}
        <p class="how-to__status" role="status" aria-live="polite">
          {restartStatus}
        </p>
      </section>

      <div class="how-to__footer">
        <img class="how-to__footer-icon" src={icons.info} alt="" />
        <span>Trades in progress are still tracked; new ones need the latest version.</span>
      </div>
    </div>
  );
}
