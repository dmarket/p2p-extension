// Blocking-state simulator: reproduce the CAUSE of each blocking state so the core resolves the state
// itself. Dev-only (this whole tree is stripped from production builds — see src/debug/protocol.ts).
//
// Why not just write `tracker.blockingReason`: because that tests the screens and nothing else. The
// mirror is rewritten from the core's live value on every `CycleStarted` (src/entrypoints/background.ts,
// deliberately with no in-memory dedupe so an external edit is corrected), so a written value survives
// milliseconds — and even if it were pinned, the core, the loop-state keys, the network log and the FE
// presence pong would all still be telling the truth. So instead:
//
//   • Two states are produced by pointing the core's own cookie READ at a name that does not exist. The
//     core then legitimately finds no cookie and runs the real signed-out path: zero network, no cookie
//     touched, nothing to undo. Applied through the same `TrackerOverrides` seam remote config uses, so
//     it needs no new machinery — just a core restart, exactly like the debug notary URL.
//   • Two are produced by intercepting one response in the service worker's `fetch`: a non-401 status on
//     the heartbeat (what the core's error path reads) and a rewritten `linkedSteamId` (what the
//     account-binding check compares).
//
// TWO RAILS ARE MANDATORY, not defensive. A session that looks gone makes the core reach for the
// credential that restores it, and both of those reaches are destructive to the developer's real
// sessions:
//
//   • Steam. A missing session opens the loop's once-per-episode mint gate, which runs
//     `refreshSession(force = true)` — `force` exists to skip the expiry self-gate. That is a real POST to
//     `jwt/ajaxrefresh` per Steam web domain plus a real `login/settoken` each, whose `Set-Cookie`
//     OVERWRITES the live `steamLoginSecure` on both community and store. Worse, the mint verifies
//     recovery by re-reading the bogus name, so it always reports "not recovered": the simulation would
//     keep working while a real session rotation happened with no signal at all. And it is not once-only —
//     every restart's forced heartbeat clears the mint latch.
//   • DMarket. Hiding only the ACCESS cookie leaves the refresh cookie visible, so the core POSTs a real
//     `/refresh-token` and rotates a token whose predecessor the backend voids — i.e. it signs the
//     developer out of dmarket.com. The scenario therefore hides both names from one code path, so that
//     variant is not expressible; the rail below is the machine check on that invariant, and it logs at
//     `error` because it must never fire.
//
// Ordering: `applySimulation` installs the rails and only then returns the overrides the caller restarts
// the core with — so the rails are always in place before the first request that could reach Steam
// (including the forced heartbeat `restartWith` fires).

import { getSettings } from '@/config/settings';
import { logCommand } from '@/debug/netLog';
import { type DemandInjection, isDemandArmed, NO_DEMAND, parseDemand } from '@/debug/demandState';
import { BLOCKING_STATES } from '@/debug/blockingStates';
import type { BlockingReason } from '@/core/blockingReason';
import {
  armedScenarios,
  DISARMED,
  parseSimulation,
  type ScenarioId,
  type SimulationState,
} from '@/debug/simulationState';
import type { TrackerOverrides } from '@/config/settings';

/** Log event tag for everything this module writes into the session log. */
const EVENT = 'Simulation';

/**
 * Cookie names the core is pointed at instead of the real ones. Deliberately fixed literals rather than
 * a mangled copy of the configured name: all that is required is a name nothing in the jar has, and a
 * self-describing one is what makes a config dump or a stray log line legible.
 */
const ABSENT_MARKETPLACE_COOKIE = 'dmp-simulated-absent-dmarket-session';
const ABSENT_MARKETPLACE_REFRESH_COOKIE = 'dmp-simulated-absent-dmarket-refresh';
const ABSENT_STEAM_COOKIE = 'dmp-simulated-absent-steam-session';

/**
 * The "other account" a simulated wrong-account heartbeat is linked to. A well-formed steamID64
 * (`^7656\d{13}$`, which is what the core's strict validator accepts) whose trailing zeros make it
 * obviously synthetic — it must be well-formed, or the response would fail to decode and the cycle
 * would land on a connection error instead of the state being simulated.
 */
const SIMULATED_LINKED_STEAM_ID = '76561190000000000';

/**
 * Status returned for a simulated DMarket outage. A deterministic 4xx on purpose: the core raises the
 * block on the FIRST such failure, while a 5xx has to fail `SERVER_ERROR_THRESHOLD` (2) cycles in a row
 * — so this lands on the restart's own forced heartbeat instead of a minute later. Change it to a 5xx
 * to exercise the debounce instead.
 */
const SIMULATED_ERROR_STATUS = 403;

/** Status used to refuse a request a rail exists to prevent. */
const RAIL_STATUS = 403;

/** What is in effect right now. Read at request time by the rails, replaced by {@link applySimulation}. */
let armed: ReadonlySet<ScenarioId> = new Set();

/** The state {@link armed} was derived from, so the console can report what the WORKER has in effect. */
let effective: SimulationState = DISARMED;

/** The hand-stamped freshness mark this worker injects, if any. Read at request time, like {@link armed}. */
let demand: DemandInjection = NO_DEMAND;

let installed = false;

/**
 * Parse the stored simulation state, put the fetch rails in effect, and return the core config overrides
 * the caller must (re)start the tracker with — `null` when nothing is armed, so the caller can leave the
 * core on its real configuration rather than restarting it into an equal-but-different config.
 *
 * The caller stays ignorant of scenario semantics on purpose: everything this module knows about how a
 * state is produced stays in this module.
 */
export function applySimulation(raw: unknown): TrackerOverrides | null {
  effective = parseSimulation(raw);
  armed = new Set(armedScenarios(effective));
  installRails();
  return trackerOverridesFor(armed);
}

/**
 * What this worker actually has in effect — not what is merely persisted. Reported by `debug:describe`
 * for the same reason the effective notary URL is: the console must show the configuration the running
 * core was started with, or it will claim a simulation that a failed apply never installed.
 */
export const effectiveSimulation = (): SimulationState => effective;

/**
 * Arm or disarm the hand-stamped freshness mark (see src/debug/demandState.ts).
 *
 * Shares the one fetch wrap with the blocking-state rails rather than installing a second: two wraps over
 * `globalThis.fetch` are order-dependent and only one survives a re-install. It shares nothing else — no
 * scenario id, no reason override, no residue — because a demand is not a blocking state.
 *
 * Needs no tracker restart, unlike {@link applySimulation}: nothing here is core CONFIG, it is a rewrite of
 * one heartbeat response, so the next heartbeat carries the mark.
 */
export function applyDemand(raw: unknown): DemandInjection {
  demand = parseDemand(raw);
  installRails();
  return demand;
}

/** What this worker is actually stamping — same contract as {@link effectiveSimulation}. */
export const effectiveDemand = (): DemandInjection => demand;

/**
 * The reason the SURFACES should show while a simulation is armed, or `null` for "no opinion — mirror the
 * core", which is what an unarmed master switch means.
 *
 * Why an override exists at all, when the whole point of this module is to simulate CAUSES: because a cause
 * can only ever ADD a block, and the chain resolves to exactly one value. A real `DM_SESSION_MISSING`
 * outranks a simulated wrong account, so with a genuinely missing DMarket session no lower-ranked simulation
 * could ever be seen — and `steam-account-mismatch` could not even be established, since its rewrite needs a
 * heartbeat that a missing session never reaches. Forcing a state to be ABSENT is not simulable in the other
 * direction either: a healthy DMarket session cannot be faked without minting a token the backend accepts.
 *
 * So while the master switch is on, the switcher is authoritative: an UNticked state is asserted to be
 * absent, and the highest-ranked ticked one is what every surface renders. The causal half still runs
 * underneath — the core really does lose the cookie, really does see the 403 — which is what keeps the loop
 * keys, the network log and the FE pong honest.
 *
 * The cost is stated where it matters (the panel and the header pill): with an override live, the mirror is
 * no longer a mirror. `debug:describe`'s `blockingReason` still reads the core directly, so the real value is
 * always one glance away.
 */
export function simulatedReason(): BlockingReason | null {
  if (!effective.enabled) return null;
  const scenarios = new Set(armedScenarios(effective));
  // BLOCKING_STATES is in precedence order, so the first hit is the winning state — the same rule the core
  // applies to its own flags.
  const hit = BLOCKING_STATES.find((s) => s.scenario !== undefined && scenarios.has(s.scenario));
  if (hit === undefined) return 'NONE';
  return hit.reason === 'NOT_ACTIVATED' ? 'NONE' : hit.reason;
}

/**
 * The core config that makes the two cookie-backed states real. Both DMarket names always move together
 * — see the module header for what happens when only one does.
 */
function trackerOverridesFor(scenarios: ReadonlySet<ScenarioId>): TrackerOverrides | null {
  const overrides: TrackerOverrides = {};
  if (scenarios.has('dm-session-missing')) {
    overrides.marketplaceScrape = {
      cookieName: ABSENT_MARKETPLACE_COOKIE,
      refreshCookieName: ABSENT_MARKETPLACE_REFRESH_COOKIE,
    };
  }
  if (scenarios.has('steam-session-missing')) {
    overrides.steamScrape = { steamSessionCookieName: ABSENT_STEAM_COOKIE };
  }
  return Object.keys(overrides).length === 0 ? null : overrides;
}

// ---- the fetch rails --------------------------------------------------------------------------------

/**
 * Wrap `globalThis.fetch` once per worker. Same bind-before-overwrite shape as
 * src/background/dev-steam-redirect.ts and src/debug/netLog.ts; `init` is forwarded BY REFERENCE (the
 * core sets `init.signal` from its own AbortController) and every request that is not being simulated
 * goes straight through.
 *
 * Installed BEFORE the core starts (src/entrypoints/background.ts), which puts it INSIDE the dev network
 * log's later wrap — so the log reports what the core actually saw, synthesized status and all, rather
 * than a request that never went out.
 */
function installRails(): void {
  if (installed) return;
  installed = true;

  const orig = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // Both halves are off in the common case, and neither is worth a URL parse then.
    if (armed.size === 0 && !isDemandArmed(demand)) return orig(input, init);
    const url = parseUrl(input);
    if (url === null) return orig(input, init);

    if (armed.has('dm-connection-error') && isHeartbeat(url)) {
      note(`heartbeat answered ${SIMULATED_ERROR_STATUS} without leaving the browser — simulating an erroring DMarket backend.`);
      return synthesize(SIMULATED_ERROR_STATUS, 'dm-connection-error');
    }
    if (armed.has('steam-session-missing') && isSteamSessionTransfer(url)) {
      note(
        `refused ${url.pathname} — the Steam session-transfer rail. The core is minting a session because ` +
          'the simulation hid its cookie; letting this through would rotate your REAL Steam session.',
      );
      return synthesize(RAIL_STATUS, 'steam-session-rail');
    }
    if (armed.has('dm-session-missing') && isTokenRefresh(url)) {
      note(
        `refused ${url.pathname} — the DMarket token-refresh rail. This must never fire: with both cookie ` +
          'names hidden the core has no refresh token to send, so a request here means the simulation is ' +
          'wrong. Letting it through would rotate your real refresh token, and the backend voids the predecessor.',
        'error',
      );
      return synthesize(RAIL_STATUS, 'dm-refresh-rail');
    }

    const res = await orig(input, init);
    if (armed.has('steam-account-mismatch') && isHeartbeat(url) && res.status === 200) {
      return rewriteLinkedSteamId(res);
    }
    if (isDemandArmed(demand) && isHeartbeat(url) && res.status === 200) {
      return stampFreshnessMark(res);
    }
    return res;
  };
}

/** The heartbeat, whatever the configured API base and path prefix are (the core builds `…/ext/heartbeat`). */
const isHeartbeat = (url: URL): boolean => url.pathname.endsWith('/heartbeat');

/**
 * The DMarket token-refresh endpoint. Matched against the configured path when one is published, so a
 * remote `tokenRefreshPath` cannot route around the rail, with the compiled suffix as the fallback.
 */
function isTokenRefresh(url: URL): boolean {
  if (url.pathname.endsWith('/refresh-token')) return true;
  const configured = getSettings().tracker.marketplaceScrape?.tokenRefreshPath;
  return configured !== undefined && url.pathname.endsWith(configured);
}

/**
 * Steam's session-transfer endpoints — the re-mint handshake and the per-domain cookie write. Derived
 * from the anti-CSRF endpoint list rather than spelled again here: that list is the one place a
 * Steam-side path change is fixed (it is remote-config-tunable for exactly that reason), and a rail that
 * silently stopped matching would rotate a real session. The trade-offer cancel entry in the same list
 * is deliberately NOT suppressed — it is a trade action, unrelated to sessions.
 */
function isSteamSessionTransfer(url: URL): boolean {
  return getSettings().web.antiCsrf.some(
    (ep) =>
      (ep.path.includes('settoken') || ep.path.includes('ajaxrefresh')) &&
      url.hostname === ep.host &&
      matchesGlob(url.pathname, ep.path),
  );
}

/** A path pattern from the anti-CSRF list, where `*` is a wildcard (as in the trade-offer cancel path). */
function matchesGlob(pathname: string, pattern: string): boolean {
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}`).test(pathname);
}

/**
 * A synthesized reply. A REAL `Response`, not a duck-typed literal: the dev network log clones it and
 * reads `res.type`. The body is never read by the core on an error status — it is there so the captured
 * entry explains itself when someone reads the log later.
 */
function synthesize(status: number, rail: string): Response {
  return new Response(JSON.stringify({ simulated: rail }), {
    status,
    statusText: 'Simulated',
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Replace the heartbeat's `linkedSteamId` with an account the browser is definitely not signed into, so
 * the core's own account-binding check resolves a wrong-account block.
 *
 * The field name is camelCase on the wire (the core's DTO pins it with `@SerialName("linkedSteamId")`),
 * and it is INJECTED when absent because a null linked id is "unknown", never a mismatch. Anything
 * unexpected — an unreadable body, a non-object payload — passes the original response through: a
 * simulation must never be able to break a cycle in a way the developer then has to debug.
 */
async function rewriteLinkedSteamId(res: Response): Promise<Response> {
  let text: string;
  try {
    text = await res.clone().text();
  } catch {
    return res;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return res;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return res;
  const before = (parsed as { linkedSteamId?: unknown }).linkedSteamId;
  (parsed as { linkedSteamId?: unknown }).linkedSteamId = SIMULATED_LINKED_STEAM_ID;
  note(
    `heartbeat linkedSteamId rewritten ${typeof before === 'string' ? before : '(absent)'} → ` +
      `${SIMULATED_LINKED_STEAM_ID} — simulating a DMarket account linked to a different Steam account.`,
  );
  // content-length / content-encoding describe the bytes we just replaced. Ktor's JS client does not
  // verify either (its `checkContentLength` is an empty function), so this is hygiene — but a stale
  // length on a body that travels through the log viewer is a lie worth not telling.
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(parsed), { status: res.status, statusText: res.statusText, headers });
}

/**
 * Stamp the armed freshness mark onto its deal's `activeTracking` entry, as the backend would.
 *
 * Only onto a deal the heartbeat ALREADY carries: the mark rides a watch entry, so inventing one would be
 * simulating a different thing (the backend deciding to track a deal) and the core would be asked to watch a
 * deal nothing else in the response describes. When the id is not there the operator is told, because a
 * silent no-op here is indistinguishable from a client that ignores marks — the exact confusion this feature
 * had to be built to resolve.
 *
 * `steamTradeId` is written alongside, because a mark without one is unanswerable and the injector refuses to
 * produce that shape (see `isDemandArmed`).
 */
async function stampFreshnessMark(res: Response): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await res.clone().text());
  } catch {
    return res;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return res;
  const tracking = (parsed as { activeTracking?: unknown }).activeTracking;
  if (!Array.isArray(tracking)) return res;
  const entry = tracking.find(
    (t): t is Record<string, unknown> =>
      typeof t === 'object' && t !== null && (t as { dealId?: unknown }).dealId === demand.dealId,
  );
  if (entry === undefined) {
    note(
      `no freshness mark stamped: this heartbeat does not track ${demand.dealId}. The mark rides a watch ` +
        'entry, so there is nothing to stamp it onto — check the deal id against the tracking list.',
    );
    return res;
  }
  entry['steamTradeId'] = demand.steamTradeId;
  entry['proveAfter'] = demand.proveAfter;
  note(
    `stamped a freshness mark on ${demand.dealId}: proveAfter=${demand.proveAfter}, ` +
      `steamTradeId=${demand.steamTradeId}. The core should now demand a proof of that trade even though ` +
      'nothing changed. It is answered ONCE — a greater mark is needed to ask again.',
  );
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(JSON.stringify(parsed), { status: res.status, statusText: res.statusText, headers });
}

/** Resolve a fetch argument to a URL, or `null` when it is not one we can reason about. */
function parseUrl(input: RequestInfo | URL): URL | null {
  let raw: string;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (input instanceof Request) raw = input.url;
  else return null;
  try {
    return new URL(raw, self.location?.href);
  } catch {
    return null;
  }
}

/**
 * Write a visible session-log entry. Every interception gets one: a synthesized reply that looked like a
 * real one would make the log — the artifact this console exists to produce — actively misleading.
 * `warn` by default so it renders in the failure colour, since none of this is normal traffic.
 */
function note(text: string, level: 'warn' | 'error' = 'warn'): void {
  void logCommand(EVENT, text, level);
}

/**
 * Loop-state keys each scenario can leave behind, cleared when that scenario is DISARMED.
 *
 * Not strictly required — the core clears every one of these itself on the first good cycle, and the
 * restart that follows a disarm forces exactly that cycle. It is here because "first good cycle" is doing
 * more work than it looks: the wrong-account verdict is only re-derived by a heartbeat that ANSWERS, so an
 * operator who armed the mismatch against dev and then switched the endpoints to prod (404 by design)
 * would be left with a persisted verdict and no reachable clear site. Clearing is self-correcting in the
 * other direction too: if the state is genuinely true, the very next cycle writes it back.
 */
const RESIDUE: Readonly<Record<ScenarioId, readonly string[]>> = {
  'dm-session-missing': [], // never persisted — re-derived at the top of every cycle
  'steam-session-missing': ['loop_steam_session_missing', 'loop_steam_mint_attempted'],
  'steam-account-mismatch': ['loop_steam_mismatch_token_id', 'loop_steam_mismatch_rechecked'],
  'dm-connection-error': ['loop_server_error_count'],
};

/**
 * Drop the loop state left by scenarios that were armed and no longer are, so that turning a simulation
 * off is deterministic rather than "whatever the next cycle happens to re-derive". Never throws.
 */
export async function clearResidue(before: SimulationState, after: SimulationState): Promise<void> {
  const stillArmed = new Set(armedScenarios(after));
  const keys = armedScenarios(before)
    .filter((id) => !stillArmed.has(id))
    .flatMap((id) => RESIDUE[id]);
  if (keys.length === 0) return;
  try {
    await browser.storage.local.remove(keys);
    note(`cleared the loop state a disarmed simulation left behind: ${keys.join(', ')}.`, 'warn');
  } catch {
    /* storage unavailable — the next successful cycle clears these anyway */
  }
}

/** Announce what is in effect (or that nothing is), for the log entry the console writes on apply. */
export function describeSimulation(scenarios: readonly ScenarioId[]): string {
  if (scenarios.length === 0) {
    return 'blocking-state simulation off — the core is back on its real configuration and re-derives the truth on the next cycle.';
  }
  return `blocking-state simulation armed: ${scenarios.join(', ')}. The core is restarted so it reads the simulated configuration, then one heartbeat is forced.`;
}
