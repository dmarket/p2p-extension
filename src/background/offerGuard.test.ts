import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  clearSimulatedVerdicts,
  forgetTrustedPartner,
  forgetRetractedScamPartners,
  keepOnlyListed,
  readVerdicts,
  RECEIVED_VERDICT_TTL_MS,
  recordPageImpersonations,
  recordSuspiciousOffers,
  SCAN_SETTLE_MS,
  settledScanStamp,
  VERDICT_TTL_MS,
} from '@/background/offerGuard';
import type { TrackerHandle } from '@/core/tracker';
import { publishRemoteConfig } from '@/testing/stubs';
import { ACTIVATION_KEY } from '@/state/activation';
import { BLOCKING_KEY } from '@/state/blocking';
import { registerOfferGuardRouter } from '@/background/router';
import {
  GUARD_CHANGED_KIND,
  GUARD_SCANNED_AT_KEY,
  GUARD_VERDICTS_KEY,
  isOfferVerdictsRequest,
  type GuardResponse,
} from '@/state/offerGuard';

const { trustPartner } = vi.hoisted(() => ({ trustPartner: vi.fn(() => Promise.resolve()) }));
vi.mock('@/core/tracker', () => ({ Tracker: { trustPartner } }));

const SCAM = '76561198781084366';
const FRIEND = '76561198000000002';

/** A `SuspiciousOutgoingOffers` frame carrying [offers] and nothing cleared. */
const record = (offers: unknown[], now?: number) => recordSuspiciousOffers({ offers, cleared: [] }, now);

/** The `SuspiciousOutgoingOffers` frame's `offers`, as the core writes it. */
const wire = (offerId: string, partnerSteamId: string, level: string, assets = 1, extra: object = {}) => ({
  offerId,
  partnerSteamId,
  level,
  assetIdsGiven: Array.from({ length: assets }, (_, i) => String(i)),
  ...extra,
});

describe('the verdict cache', () => {
  it('keeps the latest level per offer, with the partner and how much it gives', async () => {
    await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY', 3)], 1000);
    await record([wire('11', FRIEND, 'IMPERSONATION', 3), wire('12', SCAM, 'IMPERSONATION')], 2000);
    expect(await readVerdicts(2000)).toEqual({
      '11': { level: 'IMPERSONATION', direction: 'sent', partnerSteamId: FRIEND, giveCount: 3, at: 2000 },
      '12': { level: 'IMPERSONATION', direction: 'sent', partnerSteamId: SCAM, giveCount: 1, at: 2000 },
    });
  });

  it('keeps the persona name the core read from the Steam Web API', async () => {
    await record([wire('11', SCAM, 'IMPERSONATION', 1, { personaName: 'D mаrket' })], 1000);
    expect((await readVerdicts(1000))['11']).toMatchObject({ level: 'IMPERSONATION', personaName: 'D mаrket' });
  });

  it('skips malformed entries and an unknown level', async () => {
    await record([wire('x', FRIEND, 'IMPERSONATION'), wire('13', FRIEND, 'NONE'), null, 'junk'], 1000);
    expect(await readVerdicts(1000)).toEqual({});
  });

  it('forgets a verdict once it is older than the lease', async () => {
    await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY')], 1000);
    expect(await readVerdicts(1000 + VERDICT_TTL_MS - 1)).not.toEqual({});
    expect(await readVerdicts(1000 + VERDICT_TTL_MS)).toEqual({});
  });

  it('keeps a received verdict for as long as Steam keeps the offer open', async () => {
    await record([wire('11', SCAM, 'IMPERSONATION', 1, { direction: 'RECEIVED' }), wire('12', FRIEND, 'UNLINKED_GIVE_ONLY')], 1000);
    expect(Object.keys(await readVerdicts(1000 + VERDICT_TTL_MS))).toEqual(['11']);
    expect(await readVerdicts(1000 + RECEIVED_VERDICT_TTL_MS)).toEqual({});
  });

  it('drops a trusted partner give-only warnings and keeps an impersonation', async () => {
    await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY'), wire('12', FRIEND, 'IMPERSONATION')]);
    await forgetTrustedPartner(FRIEND);
    expect(Object.keys(await readVerdicts())).toEqual(['12']);
  });

  it('takes the direction from the core, and treats an offer without one as sent', async () => {
    await record([wire('11', SCAM, 'IMPERSONATION', 1, { direction: 'RECEIVED' }), wire('12', FRIEND, 'UNLINKED_GIVE_ONLY')]);
    const v = await readVerdicts();
    expect(v['11']?.direction).toBe('received');
    expect(v['12']?.direction).toBe('sent');
  });

  it('keeps the core\'s mark on a received offer flagged on the name, whatever the published scam list says', async () => {
    const received = { direction: 'RECEIVED' };
    // The core ran with its compiled list here: an empty published one must not turn its known-scam flag into a name one.
    await publishRemoteConfig({ web: { knownScamPartners: [] } });
    try {
      await record([
        wire('11', SCAM, 'IMPERSONATION', 1, received),
        wire('12', FRIEND, 'IMPERSONATION', 1, { ...received, byName: true }),
        wire('13', FRIEND, 'IMPERSONATION', 1, { byName: 'true' }),
      ]);
      const v = await readVerdicts();
      expect([v['11']?.byName, v['12']?.byName, v['13']?.byName]).toEqual([undefined, true, undefined]);
    } finally {
      await publishRemoteConfig({});
    }
  });

  it('reads a cache written before received offers as sent offers', async () => {
    await fakeBrowser.storage.session.set({
      [GUARD_VERDICTS_KEY]: { '11': { level: 'IMPERSONATION', partnerSteamId: SCAM, giveCount: 1, at: Date.now() } },
    });
    expect((await readVerdicts())['11']?.direction).toBe('sent');
  });

  it('drops the offers the core cleared, in the same write as the ones it reported', async () => {
    await record([wire('11', SCAM, 'IMPERSONATION'), wire('12', FRIEND, 'UNLINKED_GIVE_ONLY')], 1000);
    await recordSuspiciousOffers({ offers: [wire('13', SCAM, 'IMPERSONATION')], cleared: ['11', '99'] }, 1000);
    expect(Object.keys(await readVerdicts(1000)).sort()).toEqual(['12', '13']);
    // A clear alone, from a core that found nothing new.
    await recordSuspiciousOffers({ offers: [], cleared: ['12'] }, 1000);
    expect(Object.keys(await readVerdicts(1000))).toEqual(['13']);
  });

  it('keeps a trusted partner received warnings: trust is about offers the user sends', async () => {
    await record([
      wire('11', FRIEND, 'UNLINKED_GIVE_ONLY', 1, { direction: 'RECEIVED' }),
      wire('12', FRIEND, 'UNLINKED_GIVE_ONLY'),
    ]);
    await forgetTrustedPartner(FRIEND);
    expect(Object.keys(await readVerdicts())).toEqual(['11']);
  });

  it('on a full sent page drops unlisted yellow and page-found offers, keeps red core, received and simulated ones', async () => {
    await record([
      wire('11', FRIEND, 'UNLINKED_GIVE_ONLY'),
      wire('12', SCAM, 'IMPERSONATION'),
      wire('13', SCAM, 'IMPERSONATION', 1, { direction: 'RECEIVED' }),
      wire('14', FRIEND, 'UNLINKED_GIVE_ONLY', 1, { direction: 'RECEIVED' }),
      wire('15', FRIEND, 'UNLINKED_GIVE_ONLY', 1, { simulatedPersonaName: 'Sim' }),
    ]);
    await recordPageImpersonations([{ offerId: '16', partnerSteamId: SCAM, giveCount: 1 }]);
    await keepOnlyListed([]);
    expect(Object.keys(await readVerdicts()).sort()).toEqual(['12', '13', '14', '15']);
  });

  it('lets the full sent page drop a red the page raised from a yellow of the core', async () => {
    await record([wire('11', SCAM, 'UNLINKED_GIVE_ONLY')]);
    await recordPageImpersonations([{ offerId: '11', partnerSteamId: SCAM, giveCount: 1 }]);
    expect((await readVerdicts())['11']?.level).toBe('IMPERSONATION');
    await keepOnlyListed([]);
    expect(await readVerdicts()).toEqual({});
  });

  it('drops page-only impersonations whose partner left the list, keeps the core\'s own', async () => {
    await record([wire('12', SCAM, 'IMPERSONATION')]);
    await recordPageImpersonations([{ offerId: '16', partnerSteamId: SCAM, giveCount: 1 }]);
    await forgetRetractedScamPartners([SCAM]);
    expect(Object.keys(await readVerdicts()).sort()).toEqual(['12', '16']);
    await forgetRetractedScamPartners([]);
    expect(Object.keys(await readVerdicts())).toEqual(['12']);
  });

  it('forgets offers the full sent page no longer lists, but not simulated ones', async () => {
    await record([
      wire('11', FRIEND, 'UNLINKED_GIVE_ONLY'),
      wire('12', FRIEND, 'UNLINKED_GIVE_ONLY'),
      wire('13', SCAM, 'IMPERSONATION', 1, { simulatedPersonaName: 'D market' }),
    ]);
    await keepOnlyListed(['12']);
    expect(Object.keys(await readVerdicts()).sort()).toEqual(['12', '13']);
    await clearSimulatedVerdicts();
    expect(Object.keys(await readVerdicts())).toEqual(['12']);
  });
});

describe('the guard router', () => {
  const STEAM_URL = 'https://steamcommunity.com/id/me/tradeoffers/sent/';
  const STEAM_TAB = { id: fakeBrowser.runtime.id, tab: { url: STEAM_URL } } as never;

  const ask = (request: unknown, sender: object = STEAM_TAB): Promise<GuardResponse> =>
    new Promise((resolve) => void fakeBrowser.runtime.onMessage.trigger(request, sender, resolve));

  let handle: TrackerHandle | undefined;

  beforeEach(() => {
    handle = undefined;
    registerOfferGuardRouter(() => handle);
  });

  it('answers only this extension content script on a Steam tab', async () => {
    const req = { kind: 'offer-verdicts', offerIds: ['11'], pageComplete: false };
    expect(await ask(req, { id: fakeBrowser.runtime.id, tab: { url: 'https://dmarket.com/' } })).toEqual({
      ok: false,
      error: 'sender not allowed',
    });
    expect(await ask(req, { id: 'another-extension', tab: { url: STEAM_URL } })).toMatchObject({ ok: false });
  });

  it('returns the verdicts of the offers on the page only', async () => {
    await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY'), wire('99', SCAM, 'IMPERSONATION')], Date.now());
    const reply = await ask({ kind: 'offer-verdicts', offerIds: ['11'], pageComplete: false });
    expect(reply).toMatchObject({ ok: true, verdicts: { '11': { level: 'UNLINKED_GIVE_ONLY' } } });
    expect(Object.keys((reply as { verdicts: object }).verdicts)).toEqual(['11']);
    // Not the complete page, so the other offer stays cached.
    expect(Object.keys(await readVerdicts())).toContain('99');
  });

  it('hands simulated offers the page has no block for back to a debug build', async () => {
    await record([wire('13', SCAM, 'IMPERSONATION', 2, { simulatedPersonaName: 'D market' })]);
    const reply = await ask({ kind: 'offer-verdicts', offerIds: [], pageComplete: true });
    expect(reply).toMatchObject({ simulated: { '13': { simulated: { personaName: 'D market' }, giveCount: 2 } } });
  });

  it('trusts a steamid64 through the core and drops its warning; refuses anything else', async () => {
    await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY')]);
    expect(await ask({ kind: 'trust-partner', steamId: 'not-an-id' })).toEqual({ ok: false, error: 'not a steamid64' });
    expect(trustPartner).not.toHaveBeenCalled();
    expect(await ask({ kind: 'trust-partner', steamId: FRIEND })).toEqual({ ok: true });
    expect(trustPartner).toHaveBeenCalledWith(FRIEND);
    expect(await readVerdicts()).toEqual({});
  });

  it('caches what the page recognised itself, once, and raises a lower verdict without losing it', async () => {
    await publishRemoteConfig({ web: { knownScamPartners: [SCAM, FRIEND] } });
    try {
      const at = Date.now();
      await record([wire('13', FRIEND, 'UNLINKED_GIVE_ONLY', 2, { simulatedPersonaName: 'D market' })], at);
      const req = {
        kind: 'offer-verdicts',
        offerIds: ['12', '13'],
        pageComplete: false,
        impersonations: [
          { offerId: '12', partnerSteamId: SCAM, giveCount: 1 },
          { offerId: '13', partnerSteamId: FRIEND, giveCount: 2 },
        ],
      };
      await ask(req);
      const first = await readVerdicts();
      expect(first['12']).toMatchObject({ level: 'IMPERSONATION', partnerSteamId: SCAM, giveCount: 1 });
      expect(first['12']).toMatchObject({ fromPage: true });
      expect(first['13']).toEqual({
        level: 'IMPERSONATION',
        direction: 'sent',
        partnerSteamId: FRIEND,
        giveCount: 2,
        at,
        simulated: { personaName: 'D market' },
        fromPage: true,
      });
      // Asked again on a later refresh: nothing is rewritten, so no tab is woken into another refresh.
      vi.spyOn(Date, 'now').mockReturnValue(at + 5000);
      await ask(req);
      expect(await readVerdicts()).toEqual(first);
    } finally {
      await publishRemoteConfig({});
    }
  });

  describe('giving back verdicts the core already reported (DMA-859)', () => {
    const OTHER = '76561198000000005';
    const sent = (offerId: string, partnerSteamId: string, giveCount = 1) => ({ offerId, partnerSteamId, giveCount });
    const notify = (records: Record<string, string>, trusted: string[] = []) =>
      fakeBrowser.storage.local.set({
        tracker_guard_notified: JSON.stringify(records),
        guard_trusted_partners: JSON.stringify(trusted),
      });

    it('a page scan that listed nothing takes the yellow warning down, never the red one', async () => {
      await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY'), wire('12', SCAM, 'IMPERSONATION')]);
      await ask({ kind: 'offer-verdicts', offerIds: [], pageComplete: true });
      expect(Object.keys(await readVerdicts())).toEqual(['12']);
    });

    it('gives a wiped warning back once the page lists the offer again, for the page, popup and badge', async () => {
      await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY', 2), wire('12', SCAM, 'IMPERSONATION')]);
      await notify({ '11': 'UNLINKED_GIVE_ONLY', '12': 'IMPERSONATION_BY_LIST' });
      // The core will not report '11' again: it is on record at this level.
      await ask({ kind: 'offer-verdicts', offerIds: [], pageComplete: true });
      expect((await readVerdicts())['11']).toBeUndefined();

      const offerIds = ['11', '12'];
      const listed = [sent('11', FRIEND, 2), sent('12', SCAM)];
      const reply = await ask({ kind: 'offer-verdicts', offerIds, pageComplete: true, listed });
      expect(reply).toMatchObject({ verdicts: { '11': { level: 'UNLINKED_GIVE_ONLY' }, '12': { level: 'IMPERSONATION' } } });
      // The popup and the badge read this same cache.
      expect((await readVerdicts())['11']).toMatchObject({
        level: 'UNLINKED_GIVE_ONLY',
        direction: 'sent',
        partnerSteamId: FRIEND,
        giveCount: 2,
      });
    });

    it('keeps the cached verdict as it is, and takes the level the core recorded with its basis', async () => {
      await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY', 3, { personaName: 'gift_bot' })], 1000);
      await notify({ '11': 'UNLINKED_GIVE_ONLY', '12': 'IMPERSONATION', '13': 'IMPERSONATION_BY_LIST' });
      const before = (await readVerdicts(1000))['11'];
      const listed = [sent('11', FRIEND), sent('12', OTHER), sent('13', SCAM)];
      vi.spyOn(Date, 'now').mockReturnValue(1000);
      await ask({ kind: 'offer-verdicts', offerIds: ['11', '12', '13'], pageComplete: false, listed });
      const after = await readVerdicts(1000);
      expect(after['11']).toEqual(before);
      expect(after['12']).toEqual({ level: 'IMPERSONATION', direction: 'sent', partnerSteamId: OTHER, giveCount: 1, at: 1000, byName: true });
      expect(after['13']).not.toHaveProperty('byName');
    });

    it('creates nothing the core did not flag, and no give-only warning for a trusted partner', async () => {
      await notify({ '12': 'UNLINKED_GIVE_ONLY', '13': 'IMPERSONATION_BY_LIST', '14': 'NONE' }, [OTHER]);
      const listed = [sent('11', FRIEND), sent('12', OTHER), sent('13', OTHER), sent('14', FRIEND)];
      await ask({ kind: 'offer-verdicts', offerIds: ['11', '12', '13', '14'], pageComplete: true, listed });
      expect(Object.keys(await readVerdicts())).toEqual(['13']);
    });

    it('still prunes an offer that really closed: the page skips its block, so nothing gives it back', async () => {
      await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY'), wire('15', OTHER, 'UNLINKED_GIVE_ONLY')]);
      await notify({ '11': 'UNLINKED_GIVE_ONLY', '15': 'UNLINKED_GIVE_ONLY' });
      await ask({ kind: 'offer-verdicts', offerIds: ['11'], pageComplete: true, listed: [sent('11', FRIEND)] });
      expect(Object.keys(await readVerdicts())).toEqual(['11']);
    });

    it('wakes no tab for what a page scan wrote, so two sent pages that disagree cannot undo each other forever', async () => {
      await record([wire('11', FRIEND, 'UNLINKED_GIVE_ONLY')]);
      await notify({ '11': 'UNLINKED_GIVE_ONLY' });
      vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([{ id: 7 }, { id: 8 }] as never);
      const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
      // Tab 7 was loaded after offer '11' closed, tab 8 before: each write used to make both scan again.
      await ask({ kind: 'offer-verdicts', offerIds: [], pageComplete: true });
      expect((await readVerdicts())['11']).toBeUndefined();
      await ask({ kind: 'offer-verdicts', offerIds: ['11'], pageComplete: true, listed: [sent('11', FRIEND)] });
      expect((await readVerdicts())['11']).toMatchObject({ level: 'UNLINKED_GIVE_ONLY' });
      // A page-found impersonation, then the worker dropping it for a partner off its list.
      await ask({ kind: 'offer-verdicts', offerIds: ['12'], pageComplete: false, impersonations: [{ offerId: '12', partnerSteamId: SCAM, giveCount: 1 }] });
      await ask({ kind: 'offer-verdicts', offerIds: ['12'], pageComplete: false });
      expect((await readVerdicts())['12']).toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    });

    it('refuses a request whose listed offers are not on its page', () => {
      const req = { kind: 'offer-verdicts', offerIds: [], pageComplete: false, listed: [sent('11', FRIEND)] };
      expect(isOfferVerdictsRequest(req)).toBe(false);
      expect(isOfferVerdictsRequest({ ...req, offerIds: ['11'] })).toBe(true);
      expect(isOfferVerdictsRequest({ ...req, offerIds: ['11'], listed: [sent('11', 'not-a-steamid')] })).toBe(false);
    });
  });

  it('records a page impersonation as a sent offer, whatever direction the message names', async () => {
    await ask({
      kind: 'offer-verdicts',
      offerIds: ['12'],
      pageComplete: false,
      impersonations: [{ offerId: '12', partnerSteamId: SCAM, giveCount: 1, direction: 'received' }],
    });
    expect((await readVerdicts())['12']?.direction).toBe('sent');
  });

  it('refuses a page impersonation for an offer the page did not list, or a non-steamid64 partner', async () => {
    const base = { kind: 'offer-verdicts', offerIds: ['12'], pageComplete: false };
    const sendResponse = vi.fn();
    void fakeBrowser.runtime.onMessage.trigger(
      { ...base, impersonations: [{ offerId: '99', partnerSteamId: SCAM, giveCount: 1 }] },
      STEAM_TAB,
      sendResponse,
    );
    void fakeBrowser.runtime.onMessage.trigger(
      { ...base, impersonations: [{ offerId: '12', partnerSteamId: 'x', giveCount: 1 }] },
      STEAM_TAB,
      sendResponse,
    );
    expect(sendResponse).not.toHaveBeenCalled();
    expect(await readVerdicts()).toEqual({});
  });

  it('ignores messages that are not its own', async () => {
    const sendResponse = vi.fn();
    void fakeBrowser.runtime.onMessage.trigger({ kind: 'presence' }, STEAM_TAB, sendResponse);
    expect(sendResponse).not.toHaveBeenCalled();
    expect((await fakeBrowser.storage.session.get(GUARD_VERDICTS_KEY))[GUARD_VERDICTS_KEY]).toBeUndefined();
  });
});

describe('the check progress the page reads', () => {
  const STEAM_TAB = { id: fakeBrowser.runtime.id, tab: { url: 'https://steamcommunity.com/tradeoffer/9000000001/' } } as never;
  const ask = (): Promise<GuardResponse> =>
    new Promise(
      (resolve) =>
        void fakeBrowser.runtime.onMessage.trigger({ kind: 'offer-verdicts', offerIds: ['11'], pageComplete: false }, STEAM_TAB, resolve),
    );
  let handle: TrackerHandle | undefined;

  beforeEach(async () => {
    handle = {} as TrackerHandle;
    registerOfferGuardRouter(() => handle);
    await fakeBrowser.storage.local.set({ [ACTIVATION_KEY]: true, [BLOCKING_KEY]: 'NONE' });
  });

  it('answers with the core own check stamp and that the core is running', async () => {
    const stamp = Date.now() - SCAN_SETTLE_MS - 1;
    await fakeBrowser.storage.local.set({ [GUARD_SCANNED_AT_KEY]: String(stamp) });
    expect(await ask()).toMatchObject({ ok: true, scannedAt: stamp, coreRunning: true });
  });

  it('has no stamp before the first check', async () => {
    expect(await ask()).toMatchObject({ scannedAt: null, coreRunning: true });
  });

  it('says the core is not running with no handle, when blocked, or before activation', async () => {
    handle = undefined;
    expect(await ask()).toMatchObject({ coreRunning: false });
    handle = {} as TrackerHandle;
    await fakeBrowser.storage.local.set({ [BLOCKING_KEY]: 'STEAM_SESSION_MISSING' });
    expect(await ask()).toMatchObject({ coreRunning: false });
    await fakeBrowser.storage.local.set({ [BLOCKING_KEY]: 'NONE', [ACTIVATION_KEY]: false });
    expect(await ask()).toMatchObject({ coreRunning: false });
  });

  it('holds a stamp back while its check may still be reporting', () => {
    const stamp = 10_000;
    expect(settledScanStamp(stamp, {}, stamp + SCAN_SETTLE_MS - 1)).toBeNull();
    expect(settledScanStamp(stamp, {}, stamp + SCAN_SETTLE_MS)).toBe(stamp);
    const reported = { '11': { level: 'UNLINKED_GIVE_ONLY' as const, direction: 'sent' as const, partnerSteamId: FRIEND, giveCount: 1, at: stamp + 200 } };
    expect(settledScanStamp(stamp, reported, stamp + 300)).toBe(stamp);
  });
});

describe('the check stamp watch', () => {
  afterEach(() => vi.useRealTimers());

  it('tells the trade-offers tabs once per new stamp, after the settle delay, without touching the verdicts', async () => {
    vi.useFakeTimers();
    const query = vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([{ id: 7 }] as never);
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined);
    // Through the router: it is what the worker registers on every spawn.
    registerOfferGuardRouter(() => undefined);
    await fakeBrowser.storage.local.set({ [GUARD_SCANNED_AT_KEY]: '1000' });
    await vi.advanceTimersByTimeAsync(SCAN_SETTLE_MS - 1);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(7, { kind: GUARD_CHANGED_KIND });
    expect(query.mock.calls[0]?.[0]).toMatchObject({ url: expect.arrayContaining(['https://steamcommunity.com/tradeoffer/*']) });

    await fakeBrowser.storage.local.set({ [GUARD_SCANNED_AT_KEY]: '1000' });
    await fakeBrowser.storage.local.set({ other: 1 });
    await vi.advanceTimersByTimeAsync(SCAN_SETTLE_MS * 2);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await fakeBrowser.storage.session.get(GUARD_VERDICTS_KEY)).toEqual({});
  });
});
