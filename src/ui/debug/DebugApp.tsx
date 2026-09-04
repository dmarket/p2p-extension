import { StatusPanel } from '@/ui/debug/StatusPanel';
import { SettingsBar } from '@/ui/debug/SettingsBar';
import { LogViewer } from '@/ui/debug/LogViewer';
import { StoragePanel } from '@/ui/debug/StoragePanel';

/**
 * The debug console: a live network log (captured by wrapping the SW's fetch) on the left, and a
 * chrome.storage.local inspector/editor on the right. Dev-only — the `debug` entrypoint is spliced
 * out of production builds (wxt.config.ts) and the SW capture is gated behind import.meta.env.PROD.
 */
export function DebugApp(): preact.JSX.Element {
  return (
    <div class="debug">
      <StatusPanel />
      <SettingsBar />
      <div class="body">
        <LogViewer />
        <StoragePanel />
      </div>
    </div>
  );
}
