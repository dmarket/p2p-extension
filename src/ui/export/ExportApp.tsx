import { useEffect, useState } from 'preact/hooks';
import { buildDiagExport, exportFileName, serializeDiagExport } from '@/infra/diag/export';

type State =
  | { kind: 'working' }
  | { kind: 'saved'; name: string; size: number; url: string }
  | { kind: 'failed' };

function download(url: string, name: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}

const kilobytes = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * The popup's "Save file" lands here: build the file and hand it to the browser as a download. A tab rather
 * than the popup because the popup closes the moment a "Save as" dialog takes focus.
 * No `downloads` permission — an anchor download needs none, and the manifest stays as it is. It also
 * reports nothing back: the page cannot tell a saved file from a cancelled "Save as", so it never says
 * "Saved".
 */
export function ExportApp() {
  const [state, setState] = useState<State>({ kind: 'working' });

  const run = async (): Promise<void> => {
    setState({ kind: 'working' });
    try {
      const doc = await buildDiagExport();
      const blob = new Blob([serializeDiagExport(doc)], { type: 'application/json' });
      const name = exportFileName(doc.header.exportedAt);
      const url = URL.createObjectURL(blob); // freed with the tab
      download(url, name);
      setState({ kind: 'saved', name, size: blob.size, url });
    } catch {
      setState({ kind: 'failed' });
    }
  };

  useEffect(() => void run(), []);

  return (
    <main class="export-page">
      <h1>Export log for support</h1>
      <p class="export-page__status" role="status" aria-live="polite">
        {state.kind === 'working' && 'Creating the file…'}
        {state.kind === 'saved' && (
          <>
            <span class="export-page__name">{state.name}</span> ({kilobytes(state.size)}) is ready. Once your
            browser saves it, send it to DMarket support. If no file was saved, press Save again.
          </>
        )}
        {state.kind === 'failed' && "Couldn't create the file."}
      </p>
      {state.kind === 'saved' && (
        <button type="button" class="button" onClick={() => download(state.url, state.name)}>
          Save again
        </button>
      )}
      {state.kind === 'failed' && (
        <button type="button" class="button" onClick={() => void run()}>
          Retry
        </button>
      )}
    </main>
  );
}
