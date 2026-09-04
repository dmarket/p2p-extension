import { useEffect, useState } from 'preact/hooks';
import { ENVIRONMENTS, type DescribeResult } from '@/debug/protocol';
import { sendDebug } from '@/ui/debug/messaging';

/**
 * Endpoint switcher. The core talks to two endpoints — the DMarket API and the FE origin the
 * marketplace token is read from. The Prod/Stage/Dev buttons prefill both fields (they are shortcuts,
 * not a dropdown — the fields themselves are the custom input); editing either and pressing "apply &
 * restart" persists a dev-only override and restarts the tracker against the new endpoints.
 *
 * The notary URL is a third, independent field, applied on its own — the top rung of `resolveNotaryUrl`
 * (src/config/notaryUrl.ts), over a published `tracker.notary.notaryUrl` and the build's compiled default
 * under that. Setting it redirects the prover at another notary, which is what a test substrate needs;
 * emptying it drops back to a publish, or to the core's own default when there is none.
 */
export function SettingsBar(): preact.JSX.Element {
  const [apiUrl, setApiUrl] = useState('');
  const [feUrl, setFeUrl] = useState('');
  const [notaryUrl, setNotaryUrl] = useState('');
  // Shapes borrowed from DescribeResult rather than re-declared: `notaryUrl` differs only in being '' rather
  // than null, because it backs a text input.
  const [running, setRunning] = useState<Pick<DescribeResult, 'apiUrl' | 'feUrl' | 'prover'> & { notaryUrl: string }>(
    { apiUrl: '', feUrl: '', notaryUrl: '', prover: 'noop' },
  );
  const [busy, setBusy] = useState(false);

  const load = (): void => {
    void sendDebug({ type: 'debug:describe' })
      .then((r) => {
        if ('apiUrl' in r) {
          setApiUrl(r.apiUrl);
          setFeUrl(r.feUrl);
          setNotaryUrl(r.notaryUrl ?? '');
          setRunning({ apiUrl: r.apiUrl, feUrl: r.feUrl, notaryUrl: r.notaryUrl ?? '', prover: r.prover });
        }
      })
      .catch(() => {});
  };
  useEffect(load, []);

  const apply = (): void => {
    const api = apiUrl.trim();
    const fe = feUrl.trim();
    if (!api || !fe) return;
    setBusy(true);
    void sendDebug({ type: 'debug:set-endpoints', apiUrl: api, feUrl: fe })
      .then(() => setRunning((r) => ({ ...r, apiUrl: api, feUrl: fe })))
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  // Applied on its own, not folded into "apply & restart": the endpoint pair is validated as a pair
  // (both required), while the notary is independently optional — clearing it is a meaningful action.
  const applyNotary = (): void => {
    const url = notaryUrl.trim();
    setBusy(true);
    void sendDebug({ type: 'debug:set-notary', notaryUrl: url })
      // Re-describe rather than echo the URL back optimistically: whether a URL actually yields the real
      // prover is the core's answer (it also needs a host delegate), and this control exists to tell the
      // operator which prover is live — so it must not assert one it only hopes for.
      .then(load)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const dirty = apiUrl.trim() !== running.apiUrl || feUrl.trim() !== running.feUrl;
  const notaryDirty = notaryUrl.trim() !== running.notaryUrl;

  const prefill = (apiUrl: string, feUrl: string): void => {
    setApiUrl(apiUrl);
    setFeUrl(feUrl);
  };

  return (
    <section class="settings">
      <div class="env-presets">
        {ENVIRONMENTS.map((e) => (
          <button
            type="button"
            class={`preset${e.apiUrl === apiUrl.trim() && e.feUrl === feUrl.trim() ? ' active' : ''}`}
            title={`FE ${e.feUrl} · API ${e.apiUrl}`}
            onClick={() => prefill(e.apiUrl, e.feUrl)}
          >
            {e.label}
          </button>
        ))}
      </div>
      <label>
        FE URL{' '}
        <input
          class="url"
          type="text"
          value={feUrl}
          placeholder="https://dmarket.com/"
          onInput={(e) => setFeUrl((e.target as HTMLInputElement).value)}
        />
      </label>
      <label>
        API URL{' '}
        <input
          class="url"
          type="text"
          value={apiUrl}
          placeholder="https://api.dmarket.com"
          onInput={(e) => setApiUrl((e.target as HTMLInputElement).value)}
        />
      </label>
      <button
        onClick={apply}
        disabled={busy || !apiUrl.trim() || !feUrl.trim() || !dirty}
        title="restarts the tracker against both endpoints"
      >
        apply &amp; restart
      </button>
      <label>
        Notary URL{' '}
        <input
          class="url"
          type="text"
          value={notaryUrl}
          placeholder="wss://…/provenance/v1/ — empty = the core's default"
          onInput={(e) => setNotaryUrl((e.target as HTMLInputElement).value)}
        />
      </label>
      <button onClick={applyNotary} disabled={busy || !notaryDirty}>
        apply notary
      </button>
      {/*
        Two outcomes, not three: since core `.194` the prover is gated on the proof delegate alone, so
        `noop` always means this runtime cannot host it — it can no longer mean "no URL configured". The
        branch that used to say so keyed on `running.notaryUrl`, which is now unreachable.
      */}
      <span class="muted">
        {running.prover === 'tlsn'
          ? 'real TLSN prover; proof errors show as ProofFailed in the log, the MPC stack in the offscreen document’s own DevTools'
          : 'this runtime cannot host the prover — no-op, deals stay client-reported'}
      </span>
    </section>
  );
}
