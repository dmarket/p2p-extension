// Catalog of the chrome.storage.local keys the extension + vendored core persist. Used only to
// annotate the storage inspector (descriptions, sensitivity) — editing correctness relies on the
// existing value's JS type, not this catalog. Do NOT list `dmarket_p2p_tracker_tick`: it is a
// chrome.alarms name, not a storage key.

interface KeyInfo {
  desc: string;
  /**
   * Scrub the value's CREDENTIALS in the panel and in an export (`redactSecrets`); the raw value is one
   * "reveal" click away. Only for keys holding a live credential — and even then the identifiers inside stay
   * readable (`steam_credential`'s `steam_id` and expiry), because they are what a session or wrong-account
   * bug is diagnosed from and knowing one grants nothing.
   */
  sensitive?: boolean;
}

export const KNOWN_KEYS: Record<string, KeyInfo> = {
  // ---- extension-owned ----
  'activation.enabled': { desc: 'Onboarding flag (boolean). Drives the popup screen, Steam banner, and toolbar icon.' },
  // NOTE: this key does not go through the generic row at all — StoragePanel renders BlockingStatePanel
  // for it (the precedence chain, the trigger conditions and the simulator). The entry stays here so the
  // catalog remains a complete list of what the extension persists.
  'tracker.blockingReason': {
    desc:
      "Mirror of the core's blockingReason() (string), in descending precedence: DM_SESSION_MISSING | " +
      'STEAM_SESSION_MISSING | STEAM_ACCOUNT_MISMATCH | DM_CONNECTION_ERROR | NONE. Drives the popup screen, ' +
      'Steam banner and icon. Not editable: the core rewrites it on every cycle — simulate the cause instead.',
  },
  'tracker.linkedSteamId': {
    desc:
      "The DMarket-linked Steam id from the core's last wrong-account report (string) — the account the user " +
      'must sign into. Only the mismatch lifecycle event carries it, so it is persisted for surfaces opened ' +
      'later; removed when the block clears. Shown in the popup + Steam banner and in the header pills.',
  },
  'report.enabled': {
    desc:
      "Crash-reporting opt-out (boolean). Absent means ON. Toggled from the popup's Help tab; on Firefox " +
      'the platform `technicalAndInteraction` grant has to be given as well.',
  },
  'report.queue': {
    desc:
      'Crash reports written but not yet accepted by the collector (array, max 6). Written BEFORE the POST ' +
      'so a report survives the worker being torn down; drained on boot and after each enqueue.',
    // Already redacted on the way in, but it holds error text and stacks — a redaction miss would land
    // here, and this panel has a one-click export.
    sensitive: true,
  },
  'report.policy': {
    desc:
      'Crash-report rate limiting (object): the UTC day, per-bucket daily counts (internal vs ' +
      'page-originated), the per-fingerprint cooldown stamps, and how many reports the queue dropped.',
  },
  'report.install_id': {
    desc:
      'Random per-install UUID, used as the report `deviceId` only when the dmarket `dm_did` cookie is ' +
      'absent. Deleted when reporting is switched off.',
  },
  'debug.simulation': {
    desc:
      'DEV ONLY. Which blocking states are being simulated (object: {enabled, scenarios[]}), armed from the ' +
      'tracker.blockingReason row above. Re-read before the first Tracker.start on every worker spawn, so a ' +
      'simulation survives a respawn. Absent/invalid = nothing simulated.',
  },
  'remoteconfig.instance_id': { desc: 'Firebase Remote Config app_instance_id (UUID).' },
  'remoteconfig.cache': { desc: 'Cached Remote Config entries (object) for offline fallback. Holds the p2p_tracker_config JSON.' },
  'remoteconfig.fetched_at': { desc: 'Last Remote Config fetch time (epoch ms) — client-side refetch throttle.' },
  // ---- vendored core (all stored as strings) ----
  steam_credential: { desc: 'Steam session credential — JSON string containing a LIVE token.', sensitive: true },
  device_id: { desc: 'Stable device identifier (UUID) sent with every heartbeat. An id, not a credential.' },
  loop_next_heartbeat_at_ms: { desc: 'Scheduler: next heartbeat time (epoch ms, as string).' },
  loop_expedited_until_ms: { desc: 'Scheduler: expedited-polling-until time (epoch ms, as string).' },
  loop_revert_watch_at_ms: {
    desc: 'Scheduler: when GetTradeHistory (the sparse revert watch) last ran (epoch ms, as string). Gates it to ~hourly across SW respawns; absent/older than the interval = due.',
  },
  loop_server_error_count: { desc: 'Consecutive failed heartbeats ("0"/"1"/… as string) — the DM_CONNECTION_ERROR debounce.' },
  loop_steam_session_missing: {
    desc: 'Whether the last cycle found no Steam web session ("1"/"0" as string) — persisted so the block survives a worker respawn.',
  },
  loop_steam_mint_attempted: {
    desc:
      'Whether Steam has already been asked to mint a new session this episode ("1"/"0" as string). Bounds it to one ' +
      'attempt; cleared when a credential is acquired and by a force tick, so force tick doubles as the retry button.',
  },
  loop_marketplace_refresh_rejected: {
    desc:
      'Fingerprint (16 hex chars, NOT the token) of the DMarket refresh token the server last REFUSED. While the jar ' +
      'still holds that token the signed-out state costs zero network, including across worker respawns. Falsifies ' +
      'itself: a different refresh token in the jar means a different fingerprint, so nothing has to clear it — and a ' +
      'force tick deliberately does NOT, since our own cookie write would then disarm the guard.',
  },
  loop_marketplace_refreshed_at_ms: {
    desc:
      'Epoch-millis of this client\'s last completed DMarket token refresh (string) — the rotation rate limit. Every ' +
      'refresh rotates a credential shared with the browser session, so this is what stops a storm of worker spawns ' +
      'from becoming a storm of rotations.',
  },
  loop_marketplace_refresh_failures: {
    desc:
      'Consecutive DMarket refresh failures that were NOT a refusal of the token (a gateway 404, a WAF 403, a 502, a ' +
      'timeout) as a string. After the cap the client stops attempting, so a permanently broken endpoint surfaces as a ' +
      'connection error instead of costing one futile request per wake forever. Reset by any successful refresh.',
  },
  loop_steam_mismatch_token_id: {
    desc:
      'The Steam id of the TOKEN the last heartbeat found bound to a different DMarket account (string), or ' +
      'absent when the accounts agree — the persisted STEAM_ACCOUNT_MISMATCH verdict. Stored as the id, not a ' +
      'flag, so acquiring a credential for another account can retire the block without a heartbeat.',
  },
  loop_steam_mismatch_rechecked: {
    desc:
      'Whether the credential named above has already been re-acquired from Steam this episode ("1"/"0" as ' +
      'string). Bounds it to one re-scrape per wrong-account episode; cleared with the verdict and by a force ' +
      'tick (and by the Steam cookie watch, which forces one), so a real re-login retries immediately.',
  },
  tracker_reported: { desc: 'Per-deal last-reported trade status (JSON string).' },
  tracker_handled_directives: { desc: 'Directives already handled, for dedupe (JSON string).' },
  tracker_directive_outcomes: { desc: 'Outcomes of executed directives (JSON string).' },
  tracker_accepted_proofs: {
    desc:
      'Transitions the backend answered `verified: true` for, with when (JSON array of ' +
      '{dealId, source, steamStatusCode, atMs}). While an entry is inside `notary.acceptedProofTtlMs` the core ' +
      'sends that transition’s report WITHOUT re-running the prover — the safeguard against a backend ' +
      'that verifies a proof and then still answers P2P_PROOF_REQUIRED, which used to cost a full MPC session ' +
      '(~17s, ~63MB to the notary) every cycle. Pruned when the report is accepted, when a fresh proof is ' +
      'refused, and when the deal leaves tracking. DELETE a row to force a fresh proof on the next cycle.',
  },
  tracker_prove_after: {
    desc:
      'DMA-280. Where each deal stands against the backend’s `proveAfter` freshness mark (JSON map of ' +
      'dealId → {satisfiedMs, attemptingMs, attempts, retryAtMs}). When a protection hold expires the backend ' +
      'stamps a mark on the deal’s watch entry naming the trade and the instant to beat, and releases the ' +
      'payout only against a proof attested after it. `satisfiedMs` is the greatest mark a VERIFIED proof has ' +
      'answered — written on nothing else, since a mark recorded ahead of the backend’s word is the stale-flag ' +
      'payout the whole gate exists to stop. The other three are the backoff ladder for a refused one, which ' +
      'is what stops a permanently-refused mark costing one MPC session per wake. Pruned when the deal leaves ' +
      'tracking. DELETE a row to make the client answer the mark again on its next cycle.',
  },
  // ---- core-owned, previously undescribed ----
  // Written by the vendored core and catalogued here so the inspector does not show unlabelled rows next to
  // the ones above. Descriptions are the core's own (`DeviceVaultKeys`), condensed.
  tracker_online_budgets: {
    desc:
      'Per-deal online-decryption budgets learned from a refused proof (JSON map of dealId → bytes), so the ' +
      'MPC session that bought each lesson is spent once rather than on every wake. Pruned when the deal ' +
      'leaves tracking.',
  },
  tracker_deal_write_claims: {
    desc:
      'Live deal-keyed write claims — a `create_offer`/`cancel_offer` already performed or in flight per deal ' +
      '(JSON) — so the duplicate guard survives a service-worker respawn.',
  },
  tracker_steam_write_throttle: {
    desc:
      '`create_offer` back-pressure: per-partner cooldowns after a Steam rate-limit refusal plus the ' +
      'surface-wide breaker (JSON), so a cooldown outlives a respawn.',
  },
  tracker_notary_proof_throttle: {
    desc:
      'Proof-generation back-pressure: until when proving is parked after repeated failures, plus the ' +
      'escalation ladder (JSON). Persisted because every attempt is a full MPC session (~30MB to the notary), ' +
      'so a forgotten cooldown would re-spend that on every wake.',
  },
};
