// The single import site for the trade-tracker core.
//
// Everything else in the extension talks to the core through this module. The core is the published
// npm package `@dmarket/p2p-tracker-core` (resolved from node_modules); keeping it behind this single
// seam means a future source swap never touches call sites.
import {
  blockingReason as coreBlockingReason,
  createTrade as coreCreateTrade,
  deliverPush,
  enabledGameCount,
  forceHeartbeat as coreForceHeartbeat,
  isTrackingActive as coreIsTrackingActive,
  startTracker,
  startTrackerWithEvents,
  stopTracker,
  subscribeActiveTrackingCount as coreSubscribeActiveTrackingCount,
  trackerCoreVersion,
} from '@dmarket/p2p-tracker-core';
import { createNotaryProofDelegate, supportsOffscreenProver } from '@/core/notary-delegate';
// The TrackerConfig builder, shared with the offscreen prover so the two realms cannot disagree.
import { buildTrackerConfig } from '@/core/config';
// Type-only: the validated remote-config overrides the seam applies onto a fresh TrackerConfig.
import type { TrackerOverrides } from '@/config/settings';
// Type-only (erased at build): the canonical create-trade outcome shape lives in the transport module
// so the SW router and the content-script reply builder share it without either pulling in the core.
import type { CreateTradeResult } from '@/messaging/protocol';
// The parse-and-map half of that seam, in its own import-free module so the check script can run it.
import { resolveCreateTradeOutcome } from '@/core/createTradeOutcome';

// The core's blocking-reason vocabulary lives in its own dependency-free module (so the allow-list can be
// executed by scripts/check-surface-priority.mjs without pulling the 1 MB core in) and is re-exported here,
// because this seam is still where a reader expects to find the core's own surface.
import { normalizeBlockingReason } from '@/core/blockingReason';
import type { BlockingReason } from '@/core/blockingReason';
export { normalizeBlockingReason, type BlockingReason };

// The core returns an opaque handle (typed `any` in the generated .d.mts). We keep it opaque here so
// callers cannot reach into core internals.
//
// BRANDED rather than `unknown`, which is what it used to be: `unknown` absorbs every other member of a
// union, so `TrackerHandle | undefined` — the signature of every "the tracker may not have booted yet"
// getter in src/background/ — collapsed back to `unknown`, and passing `undefined` into a method that
// requires a live handle type-checked cleanly. The brand is a phantom property no caller can produce, so
// the handle stays as opaque as before while the absent case is now a real type error.
declare const trackerHandleBrand: unique symbol;
export type TrackerHandle = { readonly [trackerHandleBrand]: never };

/** A lifecycle-event JSON string emitted by the core (see the core's `LifecycleEvent.toWireJson`). */
type LifecycleEventCallback = (eventJson: string) => void;

/** Arguments for the FE fast-path create (all ids/tokens are public — no secrets cross this seam). */
interface CreateTradeArgs {
  directiveId: string;
  dealId: string;
  partnerSteamId: string;
  assetIds: string[];
  tradeToken?: string;
  /** The Steam id the DMarket account is linked to; the core guard blocks the write on a mismatch. */
  linkedSteamId?: string;
}

// The type `startTracker` expects for its `config` argument (TrackerConfig from the package's own
// .d.mts | undefined). We build the config from the domain module, so cast to this at the call site.
type StartConfig = Parameters<typeof startTracker>[1];

/**
 * Thin, typed facade over the core's exported free functions.
 *
 * The core self-drives once started: `start()` registers the core's own `chrome.alarms` listener and
 * runs cycles on its own cadence. The host's only ongoing job is to forward push payloads via
 * `deliverPush()`.
 */
export const Tracker = {
  /**
   * Boot the self-driving tracker. Call synchronously at service-worker top level on every spawn.
   * The core talks to two endpoints: the DMarket API (`baseUrl`) and the FE origin the marketplace
   * token is read from (`feUrl`). Omit `feUrl` to use the core default (`https://dmarket.com/`).
   *
   * Pass `onEvent` to subscribe to secret-free lifecycle events (e.g. `LinkedSteamIdMismatch`,
   * `HeartbeatSent`) — the SW uses it to push an unsolicited `account_mismatch` to the FE. Because the
   * SW re-runs `start` on every MV3 respawn, the subscription re-attaches automatically each boot.
   *
   * `overrides` are the validated remote-config overrides (src/config/settings.ts) applied onto a fresh
   * TrackerConfig — omit/empty to run on the core defaults (plus the FE-origin override).
   */
  start(
    baseUrl: string,
    feUrl?: string,
    onEvent?: LifecycleEventCallback,
    overrides?: TrackerOverrides,
  ): TrackerHandle {
    const config = buildTrackerConfig(feUrl, overrides) as unknown as StartConfig | undefined;
    // The notary delegate only reaches the core through startTrackerWithEvents. Not a limitation worth
    // working around: the SW always subscribes to events anyway — and the delegate IS the core's prover
    // gate now (`notaryUrl` has a production default), so this is the one argument that decides it.
    //
    // Withheld where the prover cannot run (Firefox — see supportsOffscreenProver). Passing it anyway
    // would make the core select the delegating prover and then fail inside our relay on a missing
    // `browser.offscreen`; withholding it makes the core fall back to the no-op prover, which is the
    // correct behaviour — the deal flow continues client-reported instead of breaking.
    //
    // The prover runs in another realm and so needs the config handed to it explicitly — only the two
    // groups it reads. Built from the SAME `overrides` object as `config` above, on purpose: a prover
    // configured from anything else is a prover that can disagree with the loop that dispatched to it.
    const delegate = supportsOffscreenProver()
      ? createNotaryProofDelegate({ notary: overrides?.notary, game: overrides?.game })
      : undefined;
    // The `as TrackerHandle` is the whole point of this seam: the generated .d.mts types the handle as
    // `any`, and these two lines are the ONLY place that `any` is admitted and given a name. Every
    // consumer downstream then holds a branded, opaque value it cannot dereference or confuse with
    // `undefined`.
    if (onEvent) return startTrackerWithEvents(baseUrl, config, onEvent, delegate) as TrackerHandle;
    return (config ? startTracker(baseUrl, config) : startTracker(baseUrl)) as TrackerHandle;
  },

  /**
   * FE fast-path "create trade": create the Steam offer for a committed deal. The core runs the
   * wrong-account guard before any Steam write; the device-only credential never crosses this seam.
   */
  async createTrade(handle: TrackerHandle, args: CreateTradeArgs): Promise<CreateTradeResult> {
    const json = await coreCreateTrade(
      handle,
      args.directiveId,
      args.dealId,
      args.partnerSteamId,
      args.assetIds,
      args.tradeToken,
      args.linkedSteamId,
    );
    // Not a cast: the outcome is parsed, narrowed, and its failure arms given the closed reason code the
    // page branches on — mapped from the core's own coded `cause`. The core's free-form `error` text is
    // read by nothing downstream (see src/core/createTradeOutcome.ts).
    return resolveCreateTradeOutcome(json);
  },

  /**
   * The single prioritized reason the tracker is currently blocked (see {@link BlockingReason}). This
   * is the sole source of truth for the client's blocking UI — priority is resolved in-core, so the
   * client must not derive it from anything else. Cached from the last heartbeat, recomputed each
   * cycle; no credential or Steam id crosses the seam. Fail-open (`'NONE'`) before the first heartbeat,
   * but fail-CLOSED on an unrecognised value (see {@link normalizeBlockingReason}).
   */
  blockingReason(handle: TrackerHandle): BlockingReason {
    return normalizeBlockingReason(coreBlockingReason(handle));
  },

  /**
   * `true` iff nothing is blocking the tracker — the DMarket session is usable AND the browser is on
   * the linked Steam account (the positive counterpart to {@link blockingReason}, i.e.
   * `blockingReason() === 'NONE'`). Independent of the extension's own activation flag. Fail-open like
   * `blockingReason` (before the first heartbeat it reads `'NONE'` → `true`); no secret crosses the seam.
   */
  isTrackingActive(handle: TrackerHandle): boolean {
    return coreIsTrackingActive(handle);
  },

  /** Stop the tracker (e.g. on sign-out). */
  stop(handle: TrackerHandle): void {
    stopTracker(handle);
  },

  /** Forward a push payload (from the SW `push` event) into the running tracker to nudge a cycle. */
  deliverPush(handle: TrackerHandle, payloadJson: string): Promise<void> {
    return deliverPush(handle, payloadJson);
  },

  /**
   * Subscribe to the tracker's **active-tracking count**: the live number of trades the core is
   * currently watching (the size of the backend's `active_tracking[]`, refreshed each loop cycle).
   * `onCount` fires immediately with the current value, then on every change (identical counts are
   * conflated in-core). Returns an unsubscribe function (idempotent). The value is a plain number — no
   * secret crosses the seam.
   */
  subscribeActiveTrackingCount(handle: TrackerHandle, onCount: (count: number) => void): () => void {
    return coreSubscribeActiveTrackingCount(handle, onCount);
  },

  /**
   * Force a fresh DMarket heartbeat immediately, bypassing the backend-ttl cadence gate that makes a
   * plain `deliverPush` nudge a no-op between heartbeats. The heartbeat always POSTs and re-evaluates
   * the account binding (so a resolved mismatch clears); only Steam directives/deal-watch stay gated on
   * a mismatch. Used by the dev debug console's "force tick".
   */
  forceHeartbeat(handle: TrackerHandle): Promise<void> {
    return coreForceHeartbeat(handle);
  },

  /** Core library version string. */
  version(): string {
    return trackerCoreVersion();
  },

  /** Number of games enabled in the core registry (CS2 only in v1). */
  enabledGameCount(): number {
    return enabledGameCount();
  },
};
