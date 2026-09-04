// The create-trade seam: the core's outcome JSON in, a normalised `CreateTradeResult` out — with every
// failing arm carrying the closed `CreateTradeFailureReason` code the page branches on.
//
// Why this exists. `Tracker.createTrade` used to end in `JSON.parse(json) as CreateTradeResult`, which is a
// cast and not a check: nothing validated the shape, and the bridge's only source for a failure code was a
// `reason` field the core does not write. So EVERY Steam refusal reached the page as a bare `OTHER` — a user
// at Steam's 5-offers-per-counterparty cap was told only "failed", with no cause and no retry window.
//
// The core names the cause itself now. A failed outcome carries `cause`, a stable enum name from its
// `SteamCreateFailureCause` (`COUNTERPARTY_OFFER_LIMIT`, `OUTGOING_OFFER_LIMIT`, `REQUEST_RATE_LIMITED`,
// `TRANSPORT`, `OTHER`), read in-core from Steam's own refusal wording against the marker vocabulary the core
// owns and the throttle already acts on. The host deliberately does NOT re-read that wording: `error` is
// free-form third-party text that may name urls, ids or the counterparty's persona, and it rides a frame
// delivered to an untrusted page. It is dropped here; only the code leaves. That is the rule
// src/messaging/protocol.ts states, and this module is where it holds.
//
// Two vocabularies, one map. The core's causes are the core's; `CreateTradeFailureReason` is the page's.
// They are deliberately not the same names — the page's set is a frontend contract that must be able to
// change without a core release, and the core must be able to grow a cause without a frontend one. The map
// below is the only place the two meet, and scripts/check-create-trade-cause.mjs fails the build when the
// installed core grows a cause this map has no answer for.
//
// Deliberately import-free apart from erasable `import type`s, like src/core/blockingReason.ts: that is what
// lets the check script esbuild-bundle and execute the REAL resolver rather than a copy of it.

import type { CreateTradeFailureReason, CreateTradeResult } from '@/messaging/protocol';

/**
 * The core's `SteamCreateFailureCause` members, mapped onto the page's closed set. Mirrored from the
 * installed core (asserted by scripts/check-create-trade-cause.mjs), so a cause the core grows is a decision
 * someone makes here rather than a silent fall-through to `OTHER`.
 *
 * `REQUEST_RATE_LIMITED` maps to `OTHER` on purpose, and it is the one entry that loses information. Steam
 * throttled the request *rate*; nothing about it says a quota of open offers was reached, so rendering either
 * offer limit would put "cancel some offers" in front of a user whose only remedy is to wait. The page's set
 * has no member meaning "wait, then retry" — see the note at the foot of this file.
 */
export const CAUSE_REASONS: Readonly<Record<string, CreateTradeFailureReason>> = {
  COUNTERPARTY_OFFER_LIMIT: 'LIMIT_COUNTERPARTY',
  OUTGOING_OFFER_LIMIT: 'LIMIT_OUTGOING',
  REQUEST_RATE_LIMITED: 'OTHER',
  TRANSPORT: 'NETWORK',
  OTHER: 'OTHER',
};

// Looked up through a Map, not `in` on the record: `'toString' in CAUSE_REASONS` is true via the prototype,
// and this key arrives from a JSON body.
const CAUSE_REASON_LOOKUP = new Map<string, CreateTradeFailureReason>(Object.entries(CAUSE_REASONS));

/**
 * Read the core's coded cause. Anything unrecognised is `OTHER`: a cause from a newer core, a non-string, or
 * no field at all (a core predating the coded cause — which is the state this seam was written to end, so the
 * check script fails the build on it rather than letting every refusal quietly read as unclassified).
 *
 * Unrecognised is reported as unrecognised, never as the nearest-looking limit: a wrong cause on screen is
 * worse for the user than an honest "it failed", because it prescribes a remedy that cannot work.
 */
export function mapCoreCause(cause: unknown): CreateTradeFailureReason {
  return (typeof cause === 'string' ? CAUSE_REASON_LOOKUP.get(cause) : undefined) ?? 'OTHER';
}

/**
 * Classify the core's own pre-emptive throttle, which declined the write before Steam saw it. The core
 * reports the standing cooldown's `scope` here rather than a cause, because no Steam refusal happened on
 * *this* attempt — there is nothing to classify, only a reason the attempt was not made.
 *
 * `partner` is evidence-backed: the core opens a partner cooldown only after a rate-limit refusal that named
 * that same counterparty, so the cause really is the counterparty cap. `global` is not — the surface-wide
 * block is armed by an account-wide refusal, by a `429`, or by a streak of failures of any kind across every
 * partner, so claiming `LIMIT_OUTGOING` would be an invention. `OTHER` until the page's set can say
 * "the extension is backing off".
 */
export function throttleScopeReason(scope: unknown): CreateTradeFailureReason {
  return scope === 'partner' ? 'LIMIT_COUNTERPARTY' : 'OTHER';
}

/** The core's outcome JSON, before this seam narrows it. Every field optional — none of it is validated. */
interface RawOutcome {
  ok?: unknown;
  status?: unknown;
  error?: unknown;
  cause?: unknown;
  steamOfferId?: unknown;
  duplicate?: unknown;
  linkedSteamId?: unknown;
  tokenSteamId?: unknown;
  scope?: unknown;
  retryAfterSeconds?: unknown;
}

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The fail-closed answer for an outcome body this build could not read at all.
 *
 * A factory rather than a shared constant: the result is handed to callers that are free to treat it as
 * their own, and one mutated shared object would corrupt every later failure. The core's body is
 * deliberately not echoed into it — that text is the un-inspected core payload, and this value is read by
 * the bridge on its way to an untrusted page.
 */
const unreadableOutcome = (): CreateTradeResult => ({
  ok: false,
  error: 'unparseable create-trade outcome from the core',
  reason: 'OTHER',
});

/**
 * Parse and normalise one core create-trade outcome.
 *
 * Fail-CLOSED on an unparseable body and on a status this build has never heard of: both come back as
 * failures, because a create-trade outcome is a claim about whether an item left the user's inventory, and
 * the one answer this must never invent is "it worked".
 *
 * A recognised SUCCESS status missing its `steamOfferId` is the exception and stays a success. Calling it a
 * failure would be the more dangerous lie — the offer is already on Steam, and the page's remedy for a
 * failure is to try again, which is how one create becomes two. Nothing downstream needs the id either: the
 * ack frame does not carry it (see `ExtensionMessage` in src/messaging/protocol.ts).
 */
export function resolveCreateTradeOutcome(json: string): CreateTradeResult {
  // The `try` covers exactly the one call that throws. The "is it an object" check sits after it, as a
  // plain guard: a JSON body can legally be a string, a number or `null`, none of which is an outcome.
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return unreadableOutcome();
  }
  if (typeof parsed !== 'object' || parsed === null) return unreadableOutcome();

  const raw = parsed as RawOutcome;
  const error = asString(raw.error);

  switch (raw.status) {
    case 'needs_confirmation':
    case 'created':
      return {
        ok: true,
        status: raw.status,
        steamOfferId: asString(raw.steamOfferId),
        duplicate: raw.duplicate === true,
      };

    case 'account_mismatch': {
      const linkedSteamId = asString(raw.linkedSteamId);
      const tokenSteamId = asString(raw.tokenSteamId);
      // Both ids are what the page renders ("you are signed into X, not Y"); without them the guard has
      // nothing to say, so it degrades to a plain failure rather than a half-filled mismatch frame.
      if (linkedSteamId === undefined || tokenSteamId === undefined) {
        return { ok: false, status: 'failed', error: error ?? 'account mismatch without ids', reason: 'OTHER' };
      }
      return { ok: false, status: 'account_mismatch', linkedSteamId, tokenSteamId };
    }

    case 'throttled': {
      const scope = raw.scope === 'partner' || raw.scope === 'global' ? raw.scope : 'unknown';
      return {
        ok: false,
        status: 'throttled',
        scope,
        retryAfterSeconds: typeof raw.retryAfterSeconds === 'number' ? raw.retryAfterSeconds : undefined,
        reason: throttleScopeReason(scope),
      };
    }

    case 'create_in_flight':
      return { ok: false, status: 'create_in_flight', duplicate: true, reason: 'OTHER' };

    case 'failed':
      return { ok: false, status: 'failed', error: error ?? '', reason: mapCoreCause(raw.cause) };

    default:
      // No status (the core's own blank directive_id / deal_id checks, which carry neither status nor cause)
      // or one this build does not know. Mapped all the same, so a future core status that does carry a
      // `cause` gets a real code rather than `OTHER`.
      return { ok: false, error: error ?? '', reason: mapCoreCause(raw.cause) };
  }
}

// FOLLOW-UP, not a TODO left to rot: two causes still have no honest member in the page's closed set —
// Steam's request throttling (`REQUEST_RATE_LIMITED`) and the core's surface-wide backoff (`throttled` with
// `scope: 'global'`) — and both mean "wait, then retry", which is precisely what the page cannot say today.
// `throttled` also carries a real `retryAfterSeconds` that stops at this seam, because the ack frame has no
// field for it. All three want the same additive frontend-contract change: a rate-limited/backoff reason,
// and `retry_after_seconds` on the failed ack. The core already produces both halves — the coded cause and
// the seconds — so nothing is blocked on the core; the shape of the page contract is the frontend's call.
