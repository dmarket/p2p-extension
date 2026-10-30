import { useEffect, useRef, useState } from 'preact/hooks';
import { extensionVersion } from '@/util/extensionVersion';
import { ErrorReportingToggle } from '../ErrorReportingToggle';
import { ExportLogView } from '../ExportLogView';
import { icons } from '../icons';

/** Help tab: what to do if the user's Steam account may be compromised, and the support log export. */
export function InfoScreen() {
  const [exporting, setExporting] = useState(false);
  const troubleshootingRef = useRef<HTMLButtonElement>(null);
  const returnedRef = useRef(false);

  // Back from the export view lands on the control that opened it, not on the top of the document.
  useEffect(() => {
    if (!exporting && returnedRef.current) troubleshootingRef.current?.focus();
  }, [exporting]);

  if (exporting) {
    return (
      <ExportLogView
        onBack={() => {
          returnedRef.current = true;
          setExporting(false);
        }}
      />
    );
  }

  return (
    <div class="info">
      <div class="info__intro">
        <img class="info__intro-warning" src={icons.warning} alt="" />
        <p class="info__intro-text">
          If you believe that your Steam account has been compromised, take the following steps
          immediately
        </p>
      </div>

      <ul class="info__list">
        <li>Scan your computer for viruses, keyloggers, spyware, and other malicious code.</li>
        <li>If you can log in, reset your Steam password in the Steam client settings.</li>
        <li>Reset the password for your email account associated with Steam.</li>
        <li>
          Revoke your Steam Web API key at{' '}
          <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">
            https://steamcommunity.com/dev/apikey
          </a>
          .
        </li>
        <li>
          Deauthorize all other devices in Steam Guard: go to your Steam Account Details &gt; Manage
          Steam Guard &gt; Deauthorize all other devices.
        </li>
        <li>
          Reset your Steam Trade URL at{' '}
          <a href="https://steamcommunity.com/my/tradeoffers/privacy" target="_blank" rel="noreferrer">
            https://steamcommunity.com/my/tradeoffers/privacy
          </a>{' '}
          and click "Create New URL" in the Third-Party Sites section.
        </li>
      </ul>

      <div class="info__spacer" />

      <ErrorReportingToggle />

      <div class="info__footer">
        <span>Version {extensionVersion()}</span>
        <button type="button" class="link-button" ref={troubleshootingRef} onClick={() => setExporting(true)}>
          Troubleshooting
        </button>
      </div>
    </div>
  );
}
