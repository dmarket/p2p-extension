// The core runs IF AND ONLY IF the user has activated the extension.
//
// THE DEFECT THIS CLOSES. `activation.enabled` used to gate three cosmetic things — the toolbar icon, the
// popup screen, the Steam banner — and nothing else. The service worker booted the core on every spawn
// without once reading the flag, so an installed-but-never-activated client heartbeated (and was recorded
// as an online seller), answered create directives, wrote real Steam offers and submitted notarized proofs
// that passed server-side verification. Meanwhile the presence pong reported `is_tracking_active: false`
// and the sell page correctly refused to let that same seller list. One client, two contradictory answers:
// "not ready" to the page, "working" to the backend.
//
// The cost was not cosmetic either. A deal whose trade-creation deadline expires looks at seller presence
// to decide between "we could not see them" (freeze) and "they refused" (penalty). A seller who never
// onboarded counted as present throughout, so the deal took the refusal branch against someone who was
// never told there was anything to do.
//
// THE DECISION. `activation.enabled` means what its own contract says — the user turned the extension on
// and completed onboarding — and the code now matches it: before activation there are no calls to the
// backend, no presence, and no writes to Steam. The alternative (rename the field, drop it from the
// readiness calculation, tell the page the extension works from the moment it is installed) was rejected:
// tracking-enabled is a P2P requirement, and the page already renders that meaning.
//
// WHY A RECONCILER AND NOT A START/STOP PAIR. Two independent callers decide this — the boot, which reads
// the flag once per spawn, and the storage subscription, which sees the user flip it — and in MV3 they race
// routinely: writing the flag from the Steam page wakes a worker, so the very spawn that boots is often the
// one delivering the change. Both call `reconcile()`, it is serialised, and it compares the flag against
// what is actually running, so the pair cannot start two cores or leave one running past a deactivation.
// It is also self-healing: whatever a missed event costs, the next spawn re-reads the flag and converges.

/** What the reconciler needs from the background entrypoint. Every one of these is host state, not core state. */
export interface CoreLifecycleDeps {
  /** The host-owned onboarding flag (src/state/activation.ts). Read fresh on every pass, never cached. */
  isActivated: () => Promise<boolean>;
  /** Whether a core handle exists right now. */
  isRunning: () => boolean;
  /**
   * Boot the core. `forceHeartbeat` asks for an immediate heartbeat rather than whatever the persisted
   * schedule says is due: correct when the user just pressed Activate (the point of the press is that
   * tracking starts now, and a schedule left over from a previous activated session can be up to a full
   * backend ttl away), wrong on an ordinary respawn, where a boot cycle inside a live ttl window is
   * supposed to idle. Must not throw — a failed boot is reported, never propagated.
   */
  start: (forceHeartbeat: boolean) => void;
  /**
   * Tear the core down and withdraw every claim it left behind. Called on EVERY pass that finds the flag
   * off — including the ones with nothing running — so it must be idempotent as well as non-throwing.
   */
  stop: () => void;
  /**
   * Ask an already-running core for an immediate heartbeat. Called when a forced pass finds a core that an
   * earlier unforced pass had already started, so the force is still owed. A no-op when nothing is
   * running; must not throw.
   */
  forceHeartbeat: () => void;
  /** Anything the pass itself threw (a rejected storage read, realistically). */
  onError: (error: unknown) => void;
}

export interface CoreLifecycle {
  /**
   * Re-read the activation flag and start or stop the core to match. Safe to call from anywhere, at any
   * time, as often as you like: passes are serialised, and one already queued absorbs the next rather
   * than stacking (a queued pass has not read the flag yet, so it will see whatever the newest caller
   * wrote anyway). `force` is OR-ed across whatever a pass absorbs, so a plain boot reconcile cannot
   * swallow the forced heartbeat an activation is entitled to.
   */
  reconcile: (options?: { force?: boolean }) => Promise<void>;
}

/** Build the reconciler. One per worker spawn, created by the background entrypoint. */
export function createCoreLifecycle(deps: CoreLifecycleDeps): CoreLifecycle {
  let queue: Promise<void> = Promise.resolve();
  let queued = false;
  let queuedForce = false;

  const pass = async (): Promise<void> => {
    // Claimed synchronously at the top, so a caller arriving while the `await` below is in flight queues a
    // FRESH pass instead of being absorbed into this one — which has already read its flag.
    queued = false;
    const force = queuedForce;
    queuedForce = false;

    // FAIL CLOSED. Consent that cannot be read is not consent, so a rejected read stops the core rather
    // than leaving it running: the rejection can just as easily be the pass handling a DEACTIVATION, and
    // the alternative is a core that keeps heartbeating and writing to Steam after the user asked it to
    // stop, until some later pass or spawn notices. `stop` is idempotent and non-throwing by contract, so
    // this costs nothing when nothing is running. Rethrown, not reported here, to keep one reporting site.
    // A persistently unreadable flag therefore settles OFF and stays there, which is the safe rest state.
    let activated: boolean;
    try {
      activated = await deps.isActivated();
    } catch (error) {
      deps.stop();
      throw error;
    }

    // Not activated: converge unconditionally, running core or not. The "nothing is running, so there is
    // nothing to do" shortcut this used to take was a real hole — `stop()` also WITHDRAWS what the last
    // activated session left in storage, and a spawn that finds the flag ALREADY false is precisely the
    // case where no one else will: the pass that saw the flag change never ran, because the worker was
    // evicted before it. A mismatch left behind that way outranks `NOT_ACTIVATED` on every surface, and
    // with no core to clear it the Steam page shows the wrong-account banner instead of the Activate one,
    // so the user cannot even switch tracking back on. Both halves are idempotent — the teardown returns
    // early without a handle, the withdrawals are read-compare-write — so the ordinary case, every spawn
    // of an install that was never activated, writes nothing.
    if (!activated) {
      deps.stop();
      return;
    }

    // Activated, and a core is already up. A FORCED pass is still owed its immediate heartbeat: the core
    // it found may have been started moments earlier by an unforced pass — the boot of the very worker the
    // activation write woke — and returning here would leave a just-activated user on whatever the
    // persisted schedule says, absent for up to a full backend ttl. That is the exact gap `force` exists
    // to close, so it must not be dropped merely because someone else won the race to start the core.
    if (deps.isRunning()) {
      if (force) deps.forceHeartbeat();
      return;
    }

    deps.start(force);
  };

  return {
    reconcile: (options = {}) => {
      if (options.force === true) queuedForce = true;
      if (queued) return queue;
      queued = true;
      // The catch is what keeps the chain usable: an unhandled rejection here would leave `queue` rejected
      // and every later pass would inherit it.
      queue = queue.then(pass).catch((error: unknown) => deps.onError(error));
      return queue;
    },
  };
}
