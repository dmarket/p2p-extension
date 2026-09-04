import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { LifecycleLogEntry, LogEntry, LogEntryBroadcast, NetworkLogEntry } from '@/debug/protocol';
import { sendDebug } from '@/ui/debug/messaging';
import { buildCurl, decodeBody, highlight, highlightJson, summarize } from '@/ui/debug/format';

const isNetwork = (e: LogEntry): e is NetworkLogEntry => e.category === 'network';
const isLifecycle = (e: LogEntry): e is LifecycleLogEntry => e.category === 'lifecycle';

/** Events that mean the cycle did NOT do what it looks like it did — surfaced in the failure colour. */
const LIFECYCLE_PROBLEMS = new Set([
  'CycleFailed',
  'DealLookupFailed',
  'DirectiveReportFailed',
  'HistoryCorrelationMiss',
  'ProgressStoreFailed',
  'ProofFailed',
  // Not a failure of the cycle — the loop is idle by choice — but it means the deal cannot progress, and
  // alongside a refused report it IS the deadlock signature. That is worth the failure colour.
  'ProofSuppressed',
  'SteamReadFailed',
  'TradeStatusReportFailed',
  // Deliberate, like ProofSuppressed — but it only ever fires when the transition's proof did NOT verify,
  // so it marks a deal that is not progressing. Worth the failure colour for the same reason.
  'TradeStatusReportDeferred',
]);

/**
 * Whether a lifecycle entry is a failure. Mostly a name lookup, but `ProofSubmitted` is named for its
 * happy path and carries the verdict in a FIELD: `verified=false` means the notary rejected the proof and
 * the deal will not settle, which is terminal per the core's own contract. It rendered in the normal
 * colour, so a run of five rejected proofs read as five successes — the reason a stuck deal took a human
 * reading the whole session log to explain.
 */
function isProblem(e: LifecycleLogEntry): boolean {
  if (LIFECYCLE_PROBLEMS.has(e.event)) return true;
  return e.event === 'ProofSubmitted' && e.fields?.verified === false;
}

/** `WatchSummary` reads as prose because it is the line that answers "why did this cycle send nothing?". */
function lifecycleSummary(e: LifecycleLogEntry): string {
  const fields = e.fields ?? {};
  const detail = Object.entries(fields)
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  return detail ? `${e.event} — ${detail}` : e.event;
}

/** A network entry starts a new cycle when it's a heartbeat POST (any environment host); a RequestCycle command too. */
function isTickStart(e: LogEntry): boolean {
  if (isNetwork(e)) return /\/heartbeat/i.test(e.url);
  // `CycleStarted` is the truthful boundary now that the core narrates: it also opens a WATCH-ONLY cycle,
  // which has no heartbeat to divide on and is exactly the cycle a deal-watch bug lives in.
  if (isLifecycle(e)) return e.event === 'CycleStarted';
  return e.category === 'command' && e.event === 'RequestCycle';
}

function timeOf(ts?: number): string {
  return ts ? new Date(ts).toLocaleTimeString() : '';
}

function NetworkBlocks({ e }: { e: NetworkLogEntry }): preact.JSX.Element {
  const req = decodeBody(e.requestBody);
  const resp = decodeBody(e.responseBody);
  return (
    <>
      <div class="blocklabel">curl</div>
      <pre dangerouslySetInnerHTML={{ __html: highlight(buildCurl(e), 'curl') }} />
      {/* The curl carries the body verbatim (one urlencoded line); this block is the decoded, per-field
          view of the same bytes — the readable half when a POST is what's being investigated. */}
      {req != null && (
        <>
          <div class="blocklabel req">request</div>
          <pre dangerouslySetInnerHTML={{ __html: highlight(req, 'json') }} />
        </>
      )}
      {resp != null && (
        <>
          <div class="blocklabel resp">response{e.status != null ? ` · ${e.status}` : ''}</div>
          <pre dangerouslySetInnerHTML={{ __html: highlight(resp, 'json') }} />
        </>
      )}
      {e.error && (
        <>
          <div class="blocklabel err">error</div>
          <pre>{e.error}</pre>
        </>
      )}
    </>
  );
}

/**
 * A rejected verdict carried by a 200. `/p2p/ext/notary` answers `{verified:false, reason}` with HTTP 200,
 * and `/trade-events` answers `{accepted:false, reason}` the same way — so the two exchanges this log exists
 * to explain were rendering in the ordinary colour, indistinguishable from a healthy request while scanning.
 *
 * Keyed on the body rather than the URL so it covers any endpoint that reports failure in a 200 envelope, and
 * matched on the JSON shape (with optional whitespace, since the backend pretty-prints) rather than a bare
 * substring, so the word "false" appearing anywhere else cannot colour a healthy row.
 */
const REJECTED_IN_200 = /"(?:verified|accepted)"\s*:\s*false/;

function networkFailed(e: NetworkLogEntry): boolean {
  if (e.error || (e.status != null && e.status >= 400)) return true;
  return e.responseBody != null && REJECTED_IN_200.test(e.responseBody);
}

function Entry({ e }: { e: LogEntry }): preact.JSX.Element {
  return (
    <details class="entry">
      <summary class="head">
        <span>
          <span class="seq">#{e.seq ?? '-'}</span> <span class={`cat cat-${e.category}`}>{e.category}</span>{' '}
          {isNetwork(e) ? (
            <span class={networkFailed(e) ? 'status-err' : ''}>{summarize(e)}</span>
          ) : isLifecycle(e) ? (
            <span class={isProblem(e) ? 'status-err' : ''}>{lifecycleSummary(e)}</span>
          ) : (
            <span class={e.level === 'error' ? 'status-err' : e.level === 'warn' ? 'status-warn' : ''}>
              {[e.event, e.note].filter(Boolean).join(' — ')}
            </span>
          )}
        </span>
        <span class="muted">{timeOf(e.ts)}</span>
      </summary>
      {isNetwork(e) ? (
        <NetworkBlocks e={e} />
      ) : (
        <pre dangerouslySetInnerHTML={{ __html: highlightJson(JSON.stringify(e, null, 2)) }} />
      )}
    </details>
  );
}

/**
 * Union of two entry lists by `seq`, keeping what is already on screen.
 *
 * `seq` is the store's primary key, assigned in the same transaction as the entry (see sessionLog), so it is
 * unique and monotonic — including across service-worker respawns, since the high-water mark is persisted.
 * An entry with no `seq` cannot be de-duplicated and is kept as-is rather than dropped.
 */
function mergeBySeq(current: LogEntry[], incoming: LogEntry[]): LogEntry[] {
  const seen = new Set(current.map((e) => e.seq).filter((s): s is number => s !== undefined));
  const fresh = incoming.filter((e) => e.seq === undefined || !seen.has(e.seq));
  return fresh.length === 0 ? current : [...current, ...fresh];
}

export function LogViewer(): preact.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [autoscroll, setAutoscroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initial load + live stream.
  useEffect(() => {
    let alive = true;
    // MERGED, not assigned. The listener below is registered in this same synchronous body, so an entry
    // broadcast while this round trip is in flight lands in state first and a bare `setEntries(res.entries)`
    // then clobbered it — silently, for the life of the tab, since nothing ever re-reads the store. Merging
    // on `seq` (unique and monotonic, assigned in the same IndexedDB transaction as the entry) also makes a
    // snapshot/broadcast overlap idempotent instead of a duplicate row.
    sendDebug({ type: 'debug:get-log' })
      .then((res) => alive && 'entries' in res && setEntries((prev) => mergeBySeq(prev, res.entries)))
      .catch(() => {});

    const listener = (msg: unknown): void => {
      const m = msg as Partial<LogEntryBroadcast>;
      if (m?.type === 'debug:log-entry' && m.entry) {
        setEntries((prev) => mergeBySeq(prev, [m.entry as LogEntry]));
      }
    };
    browser.runtime.onMessage.addListener(listener);
    return () => {
      alive = false;
      browser.runtime.onMessage.removeListener(listener);
    };
  }, []);

  // Autoscroll to bottom when new entries arrive.
  useEffect(() => {
    if (autoscroll && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [entries, autoscroll]);

  // Causal order, which is NOT storage order: `seq` is assigned when an entry is appended, and a network
  // entry is only appended after its response body is read — so a request always landed after the lifecycle
  // frames its own response caused, and a 30 s timeout landed in the middle of the NEXT cycle. `ts` is the
  // moment each event began (see netLog's stamp), so sorting on it restores cause before effect; `seq` breaks
  // ties, which is what keeps same-millisecond frames in the order the core emitted them.
  const ordered = [...entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));

  const clear = (): void => {
    void sendDebug({ type: 'debug:clear-log' }).catch(() => {});
    setEntries([]);
  };

  const exportLog = (): void => {
    // Exports what the panel shows, in the same causal order — the artifact QA hands over should not need
    // the reader to re-derive it.
    const blob = new Blob([JSON.stringify(ordered, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `p2p-session-log-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section class="panel">
      <div class="toolbar">
        <strong>Session log</strong>
        <span class="pill">{entries.length}</span>
        <span class="spacer" style="flex:1" />
        <button onClick={exportLog}>export</button>
        <button onClick={clear}>clear</button>
        <label class="muted">
          <input type="checkbox" checked={autoscroll} onChange={(ev) => setAutoscroll((ev.target as HTMLInputElement).checked)} />{' '}
          autoscroll
        </label>
      </div>
      <div class="scroll" ref={scrollRef}>
        {entries.length === 0 && <div class="muted">No entries yet. Press “force tick” to trigger a heartbeat.</div>}
        {ordered.map((e, i) => {
          const prev = i > 0 ? ordered[i - 1] : undefined;
          const divider = isTickStart(e) && !(prev && isTickStart(prev));
          // The key belongs on the FRAGMENT, not on `Entry` inside it: a key on a child of an unkeyed
          // wrapper is inert, so the list was diffed positionally. Network entries are back-inserted
          // mid-list (their `ts` is the request START while their `seq` is completion), which meant a
          // `<details>` the reader had expanded would collapse, or its open state would jump to a
          // different entry, every time a slow request landed.
          return (
            <Fragment key={e.seq ?? `i${i}`}>
              {divider && (
                <div class="tickdiv">
                  <span>new tick{e.ts ? ` · ${timeOf(e.ts)}` : ''}</span>
                </div>
              )}
              <Entry e={e} />
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
