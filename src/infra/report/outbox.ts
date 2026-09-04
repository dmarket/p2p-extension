// The one sender. **Service-worker only.**
//
// Order on the crash path is write-then-POST, because an MV3 worker can be torn down at any moment and a
// bare `fetch` neither resets the idle timer nor is exempt from it. Storage first means the report survives
// to the next spawn; `bootCore` drains it there.
//
// No new alarm. The core rearms its own alarm every cycle and `bootCore` re-runs on every spawn, so a
// queued report already gets a retry every few minutes for free — and this extension has been through a
// dedicated investigation to keep its wake profile as small as it is. It also sidesteps
// `alarms.create`'s `persistAcrossSessions`, which Firefox's schema rejects.
//
// Every `await` here is individually guarded. That is the real recursion protection: a rejected promise
// created by this module would land on the service worker's own `unhandledrejection` hook and call straight
// back into the reporter.

import { getSettings } from '@/config/settings';
import { hasDataCollectionGrant, isReportingEnabledByUser } from '@/infra/report/consent';
import { isCollectorEnabled, collectorConfig } from '@/infra/config';
import { POLICY_KEY, QUEUE_KEY } from '@/infra/report/keys';
import { buildPayload, type ReportPayload } from '@/infra/report/payload';
import type { PendingReport } from '@/infra/report/reporter';
import { redactAndCap } from '@/util/redact';
import { MESSAGE_MAX, STACK_MAX } from '@/infra/report/describe';

/**
 * Queue cap. Each item is bounded by the 2048 + 8192 caps, so ~11 KiB worst case — a byte cap on top would
 * be redundant. Drop-NEWEST: the first report of an episode is the one worth having, and a flood is by
 * definition repetitive.
 */
const MAX_QUEUED = 6;

/**
 * Items handled per drain, so a backlog cannot hold the worker awake. The queue is capped at
 * {@link MAX_QUEUED}, so one pass all but empties it; whatever is left is drained by the next enqueue or the
 * next spawn's boot flush.
 */
const MAX_PER_FLUSH = 6;

const REQUEST_TIMEOUT_MS = 10_000;

interface QueueItem extends PendingReport {
  /** Occurrences of this fingerprint collapsed into this item, `(xN)` in the sent message. */
  count: number;
}

interface Policy {
  /** UTC day (`YYYY-MM-DD`) the counters below belong to; a different day resets them with no timer. */
  day: string;
  /** Reports sent today from the extension's own code. */
  internal: number;
  /** Reports sent today that originated from page-controlled input — a much smaller, separate budget. */
  page: number;
  /** Whether today's "budget exhausted" notice has already been sent, per bucket. */
  noticeSent: { internal?: boolean; page?: boolean };
  /** fingerprint → last-sent epoch ms, for the cooldown. Pruned to the tracked cap on write. */
  lastSent: Record<string, number>;
  /**
   * fingerprint → RUNNING TOTAL of sightings today, including the ones the cooldown discarded.
   *
   * Cumulative on purpose. Counting "since the last send" does not work: a sent item leaves the queue, so
   * the next sighting starts from 1 — and 1 is a ladder step, so every single occurrence would send and the
   * cooldown would never bind at all.
   */
  occurrences: Record<string, number>;
  /** Reports the queue dropped, surfaced on the next successful send so the loss is visible in the data. */
  dropped: number;
}

// A FACTORY, not a shared constant. This used to be a module-scope `EMPTY_POLICY` object spread into
// readPolicy() and rollDay() — but a spread copies the three map fields BY REFERENCE, and flush()
// mutates them in place. So within one worker lifetime a UTC day roll did not actually reset the
// cooldowns, the occurrence ladder, or `noticeSent` — the last one meaning the NEXT day's
// budget-exhausted notice was silently suppressed. Found by the vitest outbox suite (fingerprints from
// one test bleeding into another through the shared maps).
const emptyPolicy = (): Policy => ({
  day: '',
  internal: 0,
  page: 0,
  noticeSent: {},
  lastSent: {},
  occurrences: {},
  dropped: 0,
});

/** How many fingerprints the policy row tracks, for both the cooldown and the occurrence ladder. */
const MAX_TRACKED_FINGERPRINTS = 32;

/** Occurrence ladder: report the 1st, 2nd, 4th, 8th… so a hot loop degrades logarithmically. */
function isLadderStep(n: number): boolean {
  return (n & (n - 1)) === 0;
}

// ---- storage serialisation ---------------------------------------------------------------------------

/**
 * One chain for every read-modify-write of the `report.*` keys.
 *
 * Without it a burst — which is the normal case, since the core emits several lifecycle events per cycle
 * and its coroutine machinery funnels every unhandled launched-job failure through one global handler —
 * has all callers read the same counters and all but the last `set` is lost, so both the caps and the
 * `dropped` accounting silently under-count.
 */
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  // Keep the chain alive whatever happens, and never leave a rejected promise unhandled (it would reach
  // the worker's `unhandledrejection` hook and re-enter the reporter).
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readQueue(): Promise<QueueItem[]> {
  try {
    const raw = (await browser.storage.local.get(QUEUE_KEY))[QUEUE_KEY];
    return Array.isArray(raw) ? (raw as QueueItem[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(items: QueueItem[]): Promise<void> {
  try {
    await browser.storage.local.set({ [QUEUE_KEY]: items });
  } catch {
    /* storage full or unavailable — the report is lost, which is strictly better than looping on it */
  }
}

async function readPolicy(): Promise<Policy> {
  try {
    const raw = (await browser.storage.local.get(POLICY_KEY))[POLICY_KEY];
    if (raw !== null && typeof raw === 'object') return { ...emptyPolicy(), ...(raw as Partial<Policy>) };
  } catch {
    /* fall through */
  }
  return emptyPolicy();
}

async function writePolicy(policy: Policy): Promise<void> {
  try {
    await browser.storage.local.set({ [POLICY_KEY]: policy });
  } catch {
    /* ignore */
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Roll the counters when the UTC day changed. No timer, no alarm — the day is read from the clock. */
function rollDay(policy: Policy): Policy {
  const day = today();
  if (policy.day === day) return policy;
  return { ...emptyPolicy(), day, dropped: policy.dropped };
}

// ---- enqueue -----------------------------------------------------------------------------------------

/**
 * Persist a report, then drain. The sink the service worker installs.
 *
 * Redaction is re-applied here even though the reporting context already did it: a relayed report crossed
 * `runtime.sendMessage` from a content script, and this is the last point before the value leaves the
 * machine. Cheap, and it means one place is responsible for the guarantee.
 */
export function enqueue(report: PendingReport): void {
  void serial(async () => {
    const scrubbed: PendingReport = {
      ...report,
      message: redactAndCap(report.message, MESSAGE_MAX),
      stack: report.stack === null ? null : redactAndCap(report.stack, STACK_MAX),
    };
    const queue = await readQueue();

    // Collapse a repeat into the item already queued rather than spending a slot on it.
    const existing = queue.find((q) => q.fingerprint === scrubbed.fingerprint);
    if (existing) {
      existing.count += 1;
      await writeQueue(queue);
    } else if (queue.length >= MAX_QUEUED) {
      const policy = rollDay(await readPolicy());
      await writePolicy({ ...policy, dropped: policy.dropped + 1 });
    } else {
      queue.push({ ...scrubbed, count: 1 });
      await writeQueue(queue);
    }
  }).then(
    () => flush(),
    () => undefined,
  );
}

// ---- flush -------------------------------------------------------------------------------------------

let flushing = false;

/**
 * Drain the queue: decide, POST, and commit only what actually landed.
 *
 * The policy is applied HERE rather than on the crash path, so the boot-crash report — the most valuable
 * one, filed when the worker may have milliseconds to live — costs a single storage write instead of three
 * round-trips before anything durable exists.
 *
 * The commit ordering is load-bearing: the daily budget, the cooldown stamp and the `dropped` counter are
 * written **after** a successful POST, never before. Committing first meant a failed send still burned a
 * budget slot, still armed the cooldown (so the retry was then suppressed by it) and still zeroed the
 * dropped count — i.e. an offline spell silently consumed the day's reporting allowance.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    if (!(await isReportingAllowed())) {
      // Turned off (or never configured): drop the backlog rather than hold it indefinitely.
      await serial(async () => writeQueue([]));
      return;
    }
    for (let i = 0; i < MAX_PER_FLUSH; i += 1) {
      const item = await serial(async () => (await readQueue())[0]);
      if (item === undefined) return;

      const verdict = await serial(async () => decide(item));
      if (!verdict.send) {
        // Suppressed by the cooldown: drop the item but remember the occurrences, so the ladder can let a
        // persistent failure through later even though each individual sighting was suppressed.
        await serial(async () => {
          const policy = rollDay(await readPolicy());
          policy.occurrences[item.fingerprint] = verdict.occurrences;
          await writePolicy(prunePolicy(policy));
          await writeQueue((await readQueue()).filter((q) => q.fingerprint !== item.fingerprint));
        });
        continue;
      }

      const settled = await send(item, verdict.suffix);
      if (!settled) return; // offline / aborted: keep it, commit nothing, try again on the next drain

      await serial(async () => {
        const policy = rollDay(await readPolicy());
        policy[verdict.bucket] += 1;
        policy.lastSent[item.fingerprint] = Date.now();
        // Stored, NOT cleared — the ladder is cumulative (see Policy.occurrences).
        policy.occurrences[item.fingerprint] = verdict.occurrences;
        if (verdict.noticeForBucket !== undefined) policy.noticeSent[verdict.noticeForBucket] = true;
        // The dropped count has now been surfaced in the message we just sent, so it starts again.
        policy.dropped = Math.max(0, policy.dropped - verdict.droppedReported);
        await writePolicy(prunePolicy(policy));
        await writeQueue((await readQueue()).filter((q) => q.fingerprint !== item.fingerprint));
      });
    }
  } catch {
    /* a flush must never throw: it runs from boot and from the crash path */
  } finally {
    flushing = false;
  }
}

interface Verdict {
  send: boolean;
  /** Appended to the message: the occurrence count, any dropped-report notice, any budget notice. */
  suffix: string;
  bucket: 'internal' | 'page';
  /** Set when this send IS the once-a-day budget-exhausted notice. */
  noticeForBucket?: 'internal' | 'page';
  /** How many dropped reports this message accounts for, so the commit subtracts exactly that. */
  droppedReported: number;
  /** Running total of sightings for this fingerprint, to be stored on a successful send. */
  occurrences: number;
}

/**
 * Decide whether to send. **Pure with respect to storage** — it reads the policy but never writes it, so a
 * failed POST leaves no trace (see the ordering note on {@link flush}).
 */
async function decide(item: QueueItem): Promise<Verdict> {
  const policy = rollDay(await readPolicy());
  const settings = getSettings().web.errorReporting;
  const bucket: 'internal' | 'page' = item.fromPage === true ? 'page' : 'internal';
  const cap = bucket === 'page' ? settings.maxPerDayFromPage : settings.maxPerDay;

  if (policy[bucket] >= cap) {
    // Emit exactly ONE notice per bucket per day. Without it a blinded reporter is indistinguishable from
    // a quiet week — which is precisely what a page flooding its own bucket would look like.
    const seen = (policy.occurrences[item.fingerprint] ?? 0) + item.count;
    if (policy.noticeSent[bucket] === true) {
      return { send: false, suffix: '', bucket, droppedReported: 0, occurrences: seen };
    }
    return {
      send: true,
      suffix: ` [${bucket} report budget exhausted for today]`,
      bucket,
      noticeForBucket: bucket,
      droppedReported: 0,
      occurrences: seen,
    };
  }

  // Running total of sightings today: the ones collapsed into this queue item plus everything already
  // recorded (including sightings the cooldown discarded). The ladder lets the 1st, 2nd, 4th, 8th… through,
  // so a persistent failure still reports periodically while a hot loop degrades logarithmically.
  const occurrences = (policy.occurrences[item.fingerprint] ?? 0) + item.count;
  const last = policy.lastSent[item.fingerprint];
  if (last !== undefined && Date.now() - last < settings.fpCooldownMs && !isLadderStep(occurrences)) {
    return { send: false, suffix: '', bucket, droppedReported: 0, occurrences };
  }

  const dropped = policy.dropped;
  return {
    send: true,
    suffix: [occurrences > 1 ? ` (x${occurrences})` : '', dropped > 0 ? ` (+${dropped} dropped)` : ''].join(''),
    bucket,
    droppedReported: dropped,
    occurrences,
  };
}

/** Bound the two per-fingerprint maps so the policy row cannot grow without limit. */
function prunePolicy(policy: Policy): Policy {
  const keep = <T>(map: Record<string, T>, byRecency: (v: T) => number): Record<string, T> =>
    Object.fromEntries(
      Object.entries(map)
        .sort((a, b) => byRecency(b[1]) - byRecency(a[1]))
        .slice(0, MAX_TRACKED_FINGERPRINTS),
    );
  return {
    ...policy,
    lastSent: keep(policy.lastSent, (v) => v),
    occurrences: keep(policy.occurrences, (v) => v),
  };
}

/** True when a POST may be made at all: configured, remotely enabled, user-enabled, and (Firefox) granted. */
async function isReportingAllowed(): Promise<boolean> {
  if (!isCollectorEnabled()) return false;
  if (!getSettings().web.errorReporting.enabled) return false;
  if (!(await isReportingEnabledByUser())) return false;
  return hasDataCollectionGrant();
}

/**
 * The single POST.
 *
 * - **No `Content-Type` header.** The body extraction then yields `text/plain;charset=UTF-8`, which is
 *   CORS-safelisted, so the request needs no preflight — and it is byte-for-byte the shape the collector
 *   already receives from the frontend's `navigator.sendBeacon`. (`sendBeacon` itself does not exist in a
 *   service worker: the Beacon API is defined on `Navigator`, and a worker has a `WorkerNavigator`.)
 * - **`credentials: 'omit'` is mandatory, not cosmetic.** `dm_did` is written for `.dmarket.com`, so a
 *   collector hosted on a dmarket subdomain is inside its cookie scope — as is `dm-trade-token`. We send
 *   the device id as a payload field on purpose; we must not also hand over the cookie jar.
 *
 * @returns true when the request settled (so the item is done), false when it should be retried later.
 */
async function send(item: QueueItem, suffix: string): Promise<boolean> {
  const url = collectorConfig.url;
  if (url === undefined) return true; // not configured: drop rather than accumulate
  let payload: ReportPayload;
  try {
    payload = await buildPayload({
      context: item.context,
      message: redactAndCap(item.message, MESSAGE_MAX, suffix),
      stack: item.stack,
      timestamp: item.timestamp,
    });
  } catch {
    return true; // cannot even build it — do not retry forever
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      keepalive: true,
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // A 4xx is a schema rejection: retrying it would loop forever, so it counts as settled.
    return response.status < 500 || response.status >= 600;
  } catch {
    return false; // offline / aborted — keep it for the next boot flush
  }
}
