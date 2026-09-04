import { useEffect, useState } from 'preact/hooks';
import {
  hasDataCollectionGrant,
  isReportingEnabledByUser,
  requestDataCollectionGrant,
  setReportingEnabledByUser,
} from '@/infra/report/consent';

/**
 * The full disclosure, shown as the row's tooltip rather than inline so the control stays one quiet line.
 *
 * It stays specific on purpose — naming what IS sent is what makes the "anonymous" in the label checkable,
 * and it is the same claim the store listings and the privacy policy have to make.
 */
const REPORTING_HINT =
  'Diagnostics only — an error message, where in the extension it happened, and the version. ' +
  'Never your Steam or DMarket credentials, and never the pages you visit.';

/** Ties the visually-hidden copy of {@link REPORTING_HINT} to the checkbox as its description. */
const HINT_ID = 'report-hint';

/**
 * The user's control over crash reporting. Default ON, which both stores allow for technical/diagnostic
 * data provided the user can turn it off — this is that off switch, and it is why the reporter is
 * describable as opt-out rather than as silent collection. AMO additionally wants the choice offered
 * "during the initial consent experience"; on Firefox that is the platform's own data-collection prompt,
 * which this toggle drives (see below).
 *
 * On **Firefox** the switch is the `technicalAndInteraction` data-collection permission itself, declared
 * `optional` in the manifest and therefore NOT granted by default. `permissions.request` needs a user
 * gesture, so it has to happen in this click handler; and the rendered state is read back from the real
 * permission rather than from our own flag, so the toggle can never claim "on" while nothing is being sent.
 *
 * On Chrome there is no equivalent platform permission, so the stored flag is the whole mechanism.
 */
export function ErrorReportingToggle() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [stored, granted] = await Promise.all([isReportingEnabledByUser(), hasDataCollectionGrant()]);
      if (live) setEnabled(stored && granted);
    })();
    return () => {
      live = false;
    };
  }, []);

  const toggle = async (): Promise<void> => {
    if (busy || enabled === null) return;
    setBusy(true);
    try {
      const next = !enabled;
      // Ask the platform FIRST when turning on: if the user declines the Firefox prompt, the stored flag
      // must not be left saying "on".
      if (next && !(await requestDataCollectionGrant())) {
        setEnabled(false);
        return;
      }
      await setReportingEnabledByUser(next);
      setEnabled(next);
    } finally {
      setBusy(false);
    }
  };

  if (enabled === null) return null; // resolved within a frame; no placeholder needed

  return (
    <>
      <label class="info__toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          // The disclosure is not the checkbox's NAME (that would make the name a paragraph), it is its
          // description — which is also how assistive tech still gets it now that the tooltip is on the
          // decorative icon rather than on the row.
          aria-describedby={HINT_ID}
          onChange={() => {
            void toggle();
          }}
        />
        <span class="info__toggle-label">
          Send anonymous error reports
          {/* `data-tip`, not `title`: a native tooltip waits about a second before appearing and that delay
              is the browser's, not something CSS or JS can shorten. The bubble is rendered from this
              attribute by `.info__toggle-more::after` and shows instantly on hover.
              The icon is drawn in CSS rather than exported from Figma — it has to inherit the label's colour
              and its own hover state, and the icons in src/assets ship pre-coloured for <img>. */}
          <span class="info__toggle-more" data-tip={REPORTING_HINT} aria-hidden="true">
            ?
          </span>
        </span>
      </label>
      {/* Outside the <label> deliberately: inside, this text would be folded into the checkbox's
          accessible name instead of its description. */}
      <span id={HINT_ID} class="visually-hidden">
        {REPORTING_HINT}
      </span>
    </>
  );
}
