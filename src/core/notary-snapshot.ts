// Per-proof prover statistics: what the prover worker knows about each proof at one instant.
//
// The worker's `ws#N PROGRESS` lines say the same thing in prose, but only on a console nobody exports, and a
// string cannot travel into a crash report without being re-parsed. This is the structure those lines are
// printed from, so the document can act on it (the stall check) and the service worker can attach the last one
// to a failed proof's report.
//
// Its own module, free of runtime dependencies, for two reasons: the worker module imports the ~1.2 MB core and
// installs global hooks at load, so nothing inside it is testable; and the document and the service worker need
// the TYPE without pulling the worker's chunk in (see the build note in notary-messages.ts).

/** The two sockets a proof opens. */
export type SocketRole = 'notary' | 'proxy';

/** What the stats read off a live socket: only its send-queue depth. */
export interface BufferedSocket {
  readonly bufferedAmount: number;
}

/**
 * One proof, one instant. Flat and primitive-only: it crosses two realm boundaries and the crash reporter's
 * `diag` is cut from it field by field. A role's fields are absent when no socket of that role could be
 * pinned to this proof — see {@link ProofStats.socket}.
 */
export interface ProofSnapshot {
  /** The last stage the prover reported (`MPC_SETUP`, `SENDING_REQUEST`, …). Exact per proof. */
  stage?: string;
  /** Seconds spent in {@link stage} so far, one decimal. */
  stageSec?: number;
  /** Since the worker started this proof. */
  elapsedMs: number;
  notarySent?: number;
  notaryRecv?: number;
  /** `WebSocket.bufferedAmount`: bytes queued by us and not yet handed to the network. */
  notaryBuffered?: number;
  /** Since bytes last moved on this socket in either direction, counted from its open. */
  notaryIdleMs?: number;
  notaryClose?: number;
  proxySent?: number;
  proxyRecv?: number;
  proxyBuffered?: number;
  proxyIdleMs?: number;
  proxyClose?: number;
  /** Proofs in flight in this realm when the snapshot was taken, this one included. */
  concurrent: number;
  /** The rayon pool size the prover was configured with. */
  threadCount?: number;
  isolated: boolean;
  /** `navigator.hardwareConcurrency`. */
  cores?: number;
  /** True when this was the first proof the worker served: it paid the ~10 MB wasm load. */
  freshWorker: boolean;
}

/** One socket's counters. Mutated by the WebSocket wrapper in the worker. */
export interface TrackedSocket {
  readonly role: SocketRole;
  /** The proof this socket belongs to, or `undefined` when that could not be known. */
  readonly proofId: string | undefined;
  readonly sock: BufferedSocket;
  sent: number;
  recv: number;
  /** 0 until the socket opens. */
  openedAt: number;
  lastMovedAt: number;
  closeCode?: number;
}

interface ProofState {
  startedAt: number;
  fresh: boolean;
  threadCount?: number;
  stage?: { name: string; since: number };
  sockets: Partial<Record<SocketRole, TrackedSocket>>;
}

export interface StatsEnv {
  now: () => number;
  isolated: () => boolean;
  cores: () => number | undefined;
}

/**
 * The proxy socket is the one dialled as `<proxyBaseUrl>/?host=<target>&port=443` (the core's transport); the
 * notary's URL carries no such query. A URL that cannot be parsed counts as the notary's, which is the socket
 * the stall check is about — a wrong guess there can only make the check fire on the proxy's silence, and the
 * check is off by default.
 */
export function socketRole(url: string): SocketRole {
  try {
    return new URL(url).searchParams.has('host') ? 'proxy' : 'notary';
  } catch {
    return 'notary';
  }
}

export class ProofStats {
  private readonly proofs = new Map<string, ProofState>();
  private started = 0;

  constructor(private readonly env: StatsEnv) {}

  begin(proofId: string, threadCount?: number): void {
    this.started += 1;
    this.proofs.set(proofId, { startedAt: this.env.now(), fresh: this.started === 1, threadCount, sockets: {} });
  }

  end(proofId: string): void {
    this.proofs.delete(proofId);
  }

  /** Stage lines come from the core's per-proof callback, so unlike sockets they are never ambiguous. */
  stage(proofId: string, name: string): void {
    const proof = this.proofs.get(proofId);
    if (proof && proof.stage?.name !== name) proof.stage = { name, since: this.env.now() };
  }

  /**
   * Register a socket as it is constructed.
   *
   * Sockets carry no proof id — the wasm glue dials them, and JS has no async context to ask which proof's
   * continuation is running. So a socket is pinned to a proof only when exactly ONE proof is in flight: then it
   * cannot belong to any other. With two in flight (`NotaryConfig.maxConcurrency` allows it) it stays unpinned,
   * and the snapshots say `concurrent: 2` instead of guessing — a guess is worse than a gap on the line a wedge
   * is diagnosed from.
   */
  socket(url: string, sock: BufferedSocket): TrackedSocket {
    const owner = this.proofs.size === 1 ? [...this.proofs.keys()][0] : undefined;
    const tracked: TrackedSocket = { role: socketRole(url), proofId: owner, sock, sent: 0, recv: 0, openedAt: 0, lastMovedAt: 0 };
    // The latest of each role wins: a re-dial replaces the dead one.
    if (owner !== undefined) this.proofs.get(owner)!.sockets[tracked.role] = tracked;
    return tracked;
  }

  opened(s: TrackedSocket): void {
    s.openedAt = this.env.now();
    s.lastMovedAt = s.openedAt;
  }

  moved(s: TrackedSocket, dir: 'sent' | 'recv', bytes: number): void {
    s[dir] += bytes;
    if (bytes > 0) s.lastMovedAt = this.env.now();
  }

  closed(s: TrackedSocket, code: number): void {
    s.closeCode = code;
  }

  /** Ms since bytes last moved on `s`, or `undefined` before it opened. */
  idleMs(s: TrackedSocket): number | undefined {
    return s.openedAt === 0 ? undefined : this.env.now() - s.lastMovedAt;
  }

  /** The stage label for a socket line, or empty when the socket is not pinned to a proof. */
  stageNote(s: TrackedSocket): string {
    const stage = s.proofId === undefined ? undefined : this.proofs.get(s.proofId)?.stage;
    return stage ? ` · ${stage.name} for ${((this.env.now() - stage.since) / 1000).toFixed(1)}s` : '';
  }

  snapshot(proofId: string): ProofSnapshot | undefined {
    const proof = this.proofs.get(proofId);
    if (!proof) return undefined;
    const now = this.env.now();
    const snap: ProofSnapshot = {
      elapsedMs: now - proof.startedAt,
      concurrent: this.proofs.size,
      isolated: this.env.isolated(),
      freshWorker: proof.fresh,
    };
    if (proof.stage) {
      snap.stage = proof.stage.name;
      snap.stageSec = Math.round((now - proof.stage.since) / 100) / 10;
    }
    if (proof.threadCount !== undefined) snap.threadCount = proof.threadCount;
    const cores = this.env.cores();
    if (cores !== undefined) snap.cores = cores;
    for (const role of ['notary', 'proxy'] as const) {
      const s = proof.sockets[role];
      if (!s) continue;
      snap[`${role}Sent`] = s.sent;
      snap[`${role}Recv`] = s.recv;
      snap[`${role}Buffered`] = s.sock.bufferedAmount;
      const idle = this.idleMs(s);
      if (idle !== undefined) snap[`${role}IdleMs`] = idle;
      if (s.closeCode !== undefined) snap[`${role}Close`] = s.closeCode;
    }
    return snap;
  }
}

/**
 * Why a proof counts as stalled, or `null`: its NOTARY socket is open and has moved no byte in either direction
 * for `stallAfterMs`. `0` disables the check. The string is the reason the proof fails with, so it reaches the
 * core's `ProofFailed.reason` and the report: stage and silence, no id.
 */
export function stallReason(snap: ProofSnapshot, stallAfterMs: number): string | null {
  if (stallAfterMs <= 0 || snap.notaryClose !== undefined || snap.notaryIdleMs === undefined) return null;
  if (snap.notaryIdleMs < stallAfterMs) return null;
  return `prover stalled: ${snap.stage ?? 'no stage yet'} for ${Math.round(snap.notaryIdleMs / 1000)}s, 0 B notary traffic`;
}

/** One line for a log, from a snapshot. Byte counts stay exact: this is read after the fact, not at a glance. */
export function describeSnapshot(snap: ProofSnapshot | undefined): string {
  if (!snap) return 'no prover snapshot received';
  const sock = (role: SocketRole): string => {
    const sent = snap[`${role}Sent`];
    if (sent === undefined) return `${role} –`;
    const close = snap[`${role}Close`];
    return (
      `${role} sent ${sent}B recv ${snap[`${role}Recv`]}B buffered ${snap[`${role}Buffered`]}B` +
      (snap[`${role}IdleMs`] !== undefined ? ` idle ${snap[`${role}IdleMs`]}ms` : '') +
      (close !== undefined ? ` closed ${close}` : '')
    );
  };
  return [
    snap.stage ? `stage ${snap.stage} ${snap.stageSec}s` : 'no stage',
    `elapsed ${snap.elapsedMs}ms`,
    sock('notary'),
    sock('proxy'),
    `concurrent ${snap.concurrent}`,
    `threads ${snap.threadCount ?? '?'} cores ${snap.cores ?? '?'}`,
    snap.isolated ? 'isolated' : 'NOT isolated',
    snap.freshWorker ? 'fresh worker' : 'reused worker',
  ].join('; ');
}
