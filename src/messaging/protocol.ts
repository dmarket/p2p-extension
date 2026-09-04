// Typed contracts for the dmarket.com page <-> extension bridge.
//
// The DMarket web app posts
// `dmarket-fe` frames on its own window; the extension replies (and, for a heartbeat-detected wrong
// account, pushes unsolicited) `dmarket-ext` frames. Both directions are origin-restricted and
// source-tagged so a page-origin echo cannot impersonate either party. Envelope keys are snake_case;
// every inbound frame carries a `correlation_id` echoed on its reply.
//
// This module has NO dependency on the core (only erasable `import type`s), so the content-script
// bundle that imports it stays lean — the core lives only in the service worker.

// Type-only (erased at build): the blocking-reason vocabulary is declared once, in the core seam.
// Importing it here keeps ONE definition of a value that now crosses the page boundary, without
// pulling the core into the content-script bundle.
import type { BlockingReason } from '@/core/tracker';

const FE_SOURCE = 'dmarket-fe';
export const EXT_SOURCE = 'dmarket-ext';

/**
 * Why a create-trade attempt failed, as a CLOSED set the page can branch on. The page must stop
 * rendering every cause as one "failed" — each of these carries its own retry rule, and the two
 * Steam limits are the ones that want a visible retry window.
 *
 * The extension maps into this set at its own boundary and never forwards the core's raw `error`
 * string: that text is free-form and may name urls or ids, and this frame is delivered to an
 * untrusted page. A code the page does not recognise, or none at all, reads as `OTHER`.
 *
 * `LIMIT_COUNTERPARTY` / `LIMIT_OUTGOING` / `NETWORK` ARE produced now. The core classifies a Steam
 * refusal itself, against the marker vocabulary it owns, and reports a coded `cause` in its outcome
 * JSON; the seam that parses that JSON (src/core/createTradeOutcome.ts) maps the core's vocabulary onto
 * this one. The two are deliberately different names: this set is a frontend contract that must be able
 * to change without a core release, and the core must be able to grow a cause without a frontend one.
 */
export type CreateTradeFailureReason =
  /** Steam refused: too many active trade offers with this one counterparty (limit 5). */
  | 'LIMIT_COUNTERPARTY'
  /** Steam refused: too many outgoing trade offers in total (limit 30). */
  | 'LIMIT_OUTGOING'
  /** The tracker is not running in this browser, so no Steam write was attempted. */
  | 'EXT_NOT_READY'
  /** Transport failure reaching Steam. Retryable without a cooldown. */
  | 'NETWORK'
  /** Any other defined error — the tolerant default, never a guess. */
  | 'OTHER';

/**
 * Exhaustive by construction: a new member of `CreateTradeFailureReason` that is not added here fails
 * `tsc`, so the runtime set can never drift behind the type.
 */
const CREATE_TRADE_FAILURE_REASONS: Record<CreateTradeFailureReason, true> = {
  LIMIT_COUNTERPARTY: true,
  LIMIT_OUTGOING: true,
  EXT_NOT_READY: true,
  NETWORK: true,
  OTHER: true,
};

// Prototype-safe membership (`'toString' in obj` would be true on the record itself).
const CREATE_TRADE_FAILURE_REASON_KEYS = new Set<string>(Object.keys(CREATE_TRADE_FAILURE_REASONS));

/**
 * Runtime narrowing for a value arriving from the core's outcome JSON, which is NOT validated at the
 * seam. Without this the `reason` field is a cast, and an unexpected string — including free-form
 * error text — would cross to the untrusted page, which is exactly what the closed set exists to stop.
 */
export function isCreateTradeFailureReason(value: unknown): value is CreateTradeFailureReason {
  return typeof value === 'string' && CREATE_TRADE_FAILURE_REASON_KEYS.has(value);
}

/** Create-trade outcome, mirrored from the core's outcome JSON and normalised by the seam that parses
 *  it (src/core/createTradeOutcome.ts). Carries only public Steam ids / enum names — never a
 *  credential. Defined here (not in the seam) so both the SW router and the content-script reply
 *  builder share one shape without pulling in the core.
 *
 *  `reason` is REQUIRED on every failing arm: the seam derives it from the core's coded cause before
 *  building the result, so an absent code would mean the seam was bypassed — not that the cause is
 *  unknown, which is `OTHER`. The bridge still defaults tolerantly, since this value reaches it across
 *  an unvalidated message boundary. */
export type CreateTradeResult =
  // `duplicate` marks the core's replayed AlreadyCreated: the offer was already on Steam, so this is one
  // success restated, not a second write. The page treats it exactly like the non-duplicate status.
  | { ok: true; status: 'needs_confirmation' | 'created'; steamOfferId?: string; duplicate?: boolean }
  | { ok: false; status: 'failed'; error: string; reason: CreateTradeFailureReason }
  // The core's OWN pre-emptive throttle: it declined to attempt the write, so Steam never saw it.
  // `scope` is the standing cooldown's scope and `retryAfterSeconds` how long is left on it — the retry
  // window the page wants. Neither crosses to the page yet; the ack carries only `reason`.
  | {
      ok: false;
      status: 'throttled';
      scope: 'partner' | 'global' | 'unknown';
      retryAfterSeconds?: number;
      reason: CreateTradeFailureReason;
    }
  // The same create is already running in this worker. Not a Steam refusal and not worth retrying — the
  // in-flight attempt will produce the real outcome.
  | { ok: false; status: 'create_in_flight'; duplicate: true; reason: CreateTradeFailureReason }
  | { ok: false; status: 'account_mismatch'; linkedSteamId: string; tokenSteamId: string }
  // No `status` at all: the core's own argument validation (blank directive_id / deal_id), plus the
  // seam's fail-closed shape for an outcome it could not parse.
  | { ok: false; error: string; reason: CreateTradeFailureReason };

// ---- Inbound: page -> extension (window.postMessage, source: "dmarket-fe") ------------------------

export type FrontendMessage =
  | { source: typeof FE_SOURCE; type: 'RequestPresence'; correlation_id: string; linked_steam_id: string }
  | {
      source: typeof FE_SOURCE;
      type: 'CreateTrade';
      correlation_id: string;
      directive_id: string;
      deal_id: string;
      partner_steam_id: string;
      asset_ids: string[];
      trade_token: string;
      linked_steam_id: string;
    }
  | { source: typeof FE_SOURCE; type: 'RequestCycle'; correlation_id: string; deal_id?: string };

// ---- Reverse: extension -> page (window.postMessage, source: "dmarket-ext") -----------------------
// Trimmed to the minimum: the FE already holds the DMarket-side context (linked id,
// directive_id, deal), so none of it is echoed back. Never carries device_id / credentials.

export type ExtensionMessage =
  | {
      source: typeof EXT_SOURCE;
      type: 'pong';
      correlation_id?: string;
      present: true;
      version: string;
      mismatch: boolean;
      /** The user has turned the extension on (completed onboarding). Host-owned, independent of the core. */
      is_activated: boolean;
      /** The extension is actively tracking: `is_activated` AND the core is unblocked (DMarket session
       *  usable AND on the linked Steam account, i.e. `blockingReason==='NONE'`). Never true when
       *  `is_activated` is false — an un-activated extension does not track. */
      is_tracking_active: boolean;
      /**
       * WHICH check is blocking, priority already resolved in-core. The two
       * booleans above say only THAT tracking is off; naming the failed check is what lets the page
       * tell "install it" from "you are signed into the wrong Steam account". `UNKNOWN` is the
       * host's fail-closed value for a reason it does not recognise — render it as blocked.
       */
      blocking_reason: BlockingReason;
    }
  // Discriminated on `status` so a stale `reason` cannot ride along on a success: the success arm has
  // no such field, and the failure arm always carries one (`OTHER` when nothing classified it).
  | { source: typeof EXT_SOURCE; type: 'ack'; correlation_id?: string; status: 'needs_confirmation' | 'created' }
  | {
      source: typeof EXT_SOURCE;
      type: 'ack';
      correlation_id?: string;
      status: 'failed';
      /** Always set on a failure. See CreateTradeFailureReason. */
      reason: CreateTradeFailureReason;
    }
  // `correlation_id` is absent on the unsolicited heartbeat-driven variant (no request to correlate to).
  | { source: typeof EXT_SOURCE; type: 'account_mismatch'; correlation_id?: string; token_steam_id: string };

// ---- Internal: content script <-> service worker (browser.runtime.sendMessage) --------------------

export type BridgeRequest =
  | { kind: 'presence' }
  | {
      kind: 'create-trade';
      directiveId: string;
      dealId: string;
      partnerSteamId: string;
      assetIds: string[];
      tradeToken?: string;
      linkedSteamId?: string;
    }
  | { kind: 'request-cycle'; dealId?: string };

export type BridgeResponse =
  | {
      ok: true;
      kind: 'presence';
      version: string;
      mismatch: boolean;
      isActivated: boolean;
      isTrackingActive: boolean;
      blockingReason: BlockingReason;
    }
  | { ok: true; kind: 'create-trade'; result: CreateTradeResult }
  // `request-cycle` carries no payload: the nudge is fire-and-forget and the page gets no reverse frame
  // for it (see src/messaging/bridge.ts), so there is nothing for a status string to be read by.
  | { ok: true; kind: 'request-cycle' }
  // `reason` lets an SW-level failure of a create-trade request arrive coded rather than as free text
  // the bridge would have to pattern-match.
  | { ok: false; error: string; reason?: CreateTradeFailureReason };

// ---- SW -> content script push (browser.tabs.sendMessage) -----------------------------------------
// The one message the extension initiates: when a heartbeat detects a wrong account, the SW pushes to
// every dmarket tab so the content script can emit an unsolicited `account_mismatch` to the page.

export interface AccountMismatchPush {
  kind: 'push-account-mismatch';
  tokenSteamId: string;
}

/** Narrow an untrusted `window.postMessage` payload to a known, well-formed frontend frame. */
export function isFrontendMessage(data: unknown): data is FrontendMessage {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.source !== FE_SOURCE) return false;
  if (typeof d.correlation_id !== 'string') return false; // every inbound frame carries one
  switch (d.type) {
    case 'RequestPresence':
      return typeof d.linked_steam_id === 'string';
    case 'RequestCycle':
      return d.deal_id === undefined || typeof d.deal_id === 'string';
    case 'CreateTrade':
      return (
        typeof d.directive_id === 'string' &&
        typeof d.deal_id === 'string' &&
        typeof d.partner_steam_id === 'string' &&
        Array.isArray(d.asset_ids) &&
        d.asset_ids.every((a) => typeof a === 'string') &&
        typeof d.trade_token === 'string' &&
        typeof d.linked_steam_id === 'string'
      );
    default:
      return false;
  }
}

/** Narrow a `browser.runtime` message to a known bridge request (service-worker side). */
export function isBridgeRequest(message: unknown): message is BridgeRequest {
  if (typeof message !== 'object' || message === null) return false;
  const kind = (message as { kind?: unknown }).kind;
  return kind === 'presence' || kind === 'create-trade' || kind === 'request-cycle';
}

/** Narrow a `browser.runtime` message to the SW->content-script account-mismatch push. */
export function isAccountMismatchPush(message: unknown): message is AccountMismatchPush {
  if (typeof message !== 'object' || message === null) return false;
  const m = message as Record<string, unknown>;
  return m.kind === 'push-account-mismatch' && typeof m.tokenSteamId === 'string';
}
