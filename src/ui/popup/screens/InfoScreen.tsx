import { ErrorReportingToggle } from '../ErrorReportingToggle';
import { icons } from '../icons';

interface InfoScreenProps {
  onClose: () => void;
}

/** Help tab: what to do if the user's Steam account may be compromised. */
export function InfoScreen({ onClose }: InfoScreenProps) {
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

      <button type="button" class="button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
