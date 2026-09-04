import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stubFetch } from '@/testing/stubs';

// The blocking-state simulator, and above all its TWO SECURITY RAILS. A simulated missing session makes
// the core reach for the credential that restores it, and both reaches are destructive to the developer's
// REAL sessions: the Steam mint rotates the live `steamLoginSecure` on both domains, and a DMarket
// `/refresh-token` rotates a token whose predecessor the backend voids (signing the developer out).
// A simulator that quietly stopped railing would do real damage while looking like it works.

// The session log lives behind IndexedDB in the real console; keep this file pure and capture the notes.
const notes = vi.hoisted(() => [] as { text: string; level: string }[]);
vi.mock('@/debug/netLog', () => ({
  logCommand: (_event: string, text: string, level: string) => {
    notes.push({ text, level });
    return Promise.resolve();
  },
}));

// parseSimulation / DISARMED are pure and stateless, so one static instance serves every test.
import { DISARMED, parseSimulation } from '@/debug/simulationState';

const armedState = (...scenarios: string[]) => ({ enabled: true, scenarios });

// A FRESH module per test, because the module and the test harness both manage `globalThis.fetch`:
// simulate.ts wraps it ONCE per worker (an `installed` latch, correct in production), while
// `unstubGlobals` restores the global after each test — which silently removes the wrap from a module
// that still believes it is installed, so every rail no-ops from the second test on. resetModules gives
// each test its own latch, wrapping that test's own fetch stub.
type Simulate = typeof import('@/debug/simulate');
let applySimulation: Simulate['applySimulation'];
let applyDemand: Simulate['applyDemand'];
let clearResidue: Simulate['clearResidue'];
let effectiveDemand: Simulate['effectiveDemand'];
let effectiveSimulation: Simulate['effectiveSimulation'];
let simulatedReason: Simulate['simulatedReason'];

let fetchMock: ReturnType<typeof stubFetch>;
beforeEach(async () => {
  notes.length = 0;
  vi.resetModules();
  // parseUrl reads `self.location` (a worker global). In node `self` does not exist, the ReferenceError
  // is swallowed by parseUrl's own try, every URL resolves to null — and the rails silently skip, which
  // is exactly the failure this suite exists to catch, so it must not be the harness causing it.
  vi.stubGlobal('self', globalThis);
  fetchMock = stubFetch();
  ({ applyDemand, applySimulation, clearResidue, effectiveDemand, effectiveSimulation, simulatedReason } =
    await import('@/debug/simulate'));
});

describe('the tracker overrides', () => {
  it('dm-session-missing hides BOTH DMarket cookie names — the destructive variant is inexpressible', () => {
    // Hiding only the access cookie leaves the refresh cookie visible, so the core would POST a real
    // /refresh-token: one code path sets both names, making that variant impossible to express.
    const overrides = applySimulation(armedState('dm-session-missing'));
    expect(overrides?.marketplaceScrape?.cookieName).toMatch(/^dmp-simulated-absent/);
    expect(overrides?.marketplaceScrape?.refreshCookieName).toMatch(/^dmp-simulated-absent/);
  });

  it('steam-session-missing points only the Steam session cookie at an absent name', () => {
    const overrides = applySimulation(armedState('steam-session-missing'));
    expect(overrides?.steamScrape?.steamSessionCookieName).toMatch(/^dmp-simulated-absent/);
    expect(overrides?.marketplaceScrape).toBeUndefined();
  });

  it('the fetch-backed scenarios need no core overrides, and nothing armed means null (no restart)', () => {
    expect(applySimulation(armedState('dm-connection-error', 'steam-account-mismatch'))).toBeNull();
    expect(applySimulation(DISARMED)).toBeNull();
    expect(applySimulation(armedState())).toBeNull();
  });
});

describe('the fetch rails', () => {
  it('dm-connection-error answers the heartbeat 403 without leaving the browser', async () => {
    applySimulation(armedState('dm-connection-error'));
    const res = await fetch('https://api.dmarket.com/exchange/v1/ext/heartbeat', { method: 'POST' });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ simulated: 'dm-connection-error' });
    expect(fetchMock).not.toHaveBeenCalled(); // synthesized, not sent
    expect(notes.at(-1)?.level).toBe('warn'); // every interception is narrated, in the failure colour
  });

  it('the STEAM rail refuses both session-transfer endpoints while the session is simulated away', async () => {
    // The core's once-per-episode mint gate runs refreshSession(force=true) when the session looks gone —
    // a real POST whose Set-Cookie overwrites the live steamLoginSecure on both domains.
    applySimulation(armedState('steam-session-missing'));
    for (const url of [
      'https://login.steampowered.com/jwt/ajaxrefresh?redir=x',
      'https://steamcommunity.com/login/settoken',
      'https://store.steampowered.com/login/settoken',
    ]) {
      const res = await fetch(url, { method: 'POST' });
      expect(res.status, url).toBe(403);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the Steam rail does NOT suppress the trade-offer cancel (a trade action, not a session one)', async () => {
    applySimulation(armedState('steam-session-missing'));
    fetchMock.mockResolvedValue(new Response('ok'));
    await fetch('https://steamcommunity.com/tradeoffer/123/cancel', { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // passed through
  });

  it('the DMARKET rail refuses /refresh-token at ERROR level — it firing at all means the simulation is wrong', async () => {
    applySimulation(armedState('dm-session-missing'));
    const res = await fetch('https://api.dmarket.com/marketplace-api/v1/refresh-token', { method: 'POST' });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ simulated: 'dm-refresh-rail' });
    expect(fetchMock).not.toHaveBeenCalled();
    // The LEVEL, not the sentence: this rail firing at all means the simulation is wrong, and `error` is
    // how that reaches the operator. Keyed on the machine-readable field so rewording the note is free.
    expect(notes.at(-1)?.level).toBe('error');
  });

  it('unrelated traffic passes through untouched, by-reference init included', async () => {
    applySimulation(armedState('dm-connection-error', 'steam-session-missing', 'dm-session-missing'));
    fetchMock.mockResolvedValue(new Response('ok'));
    const init = { method: 'GET' };
    await fetch('https://api.steampowered.com/IEconService/GetTradeOffers/v1/', init);
    // The exact init object: the core sets init.signal from its own AbortController, so a rebuilt or
    // spread init would silently break its request cancellation.
    expect(fetchMock).toHaveBeenCalledWith('https://api.steampowered.com/IEconService/GetTradeOffers/v1/', init);
  });

  it('nothing armed means every request passes through', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    await fetch('https://api.dmarket.com/exchange/v1/ext/heartbeat');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('the wrong-account rewrite', () => {
  const heartbeat = (body: unknown) =>
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': '999' },
      }),
    );

  it('rewrites linkedSteamId in a real 200 body', async () => {
    applySimulation(armedState('steam-account-mismatch'));
    heartbeat({ linkedSteamId: '76561198338780301', ttlSeconds: 92 });
    const res = await fetch('https://api.dmarket.com/exchange/v1/ext/heartbeat');
    const body = (await res.json()) as { linkedSteamId: string; ttlSeconds: number };
    expect(body.linkedSteamId).toBe('76561190000000000'); // well-formed and obviously synthetic
    expect(body.ttlSeconds).toBe(92); // the rest of the payload rides through
    // The stale declared length of the body we replaced must not travel.
    expect(res.headers.get('content-length')).toBeNull();
  });

  it('INJECTS the field when absent — a null linked id is "unknown", never a mismatch', async () => {
    applySimulation(armedState('steam-account-mismatch'));
    heartbeat({ ttlSeconds: 92 });
    const res = await fetch('https://api.dmarket.com/exchange/v1/ext/heartbeat');
    expect(((await res.json()) as { linkedSteamId: string }).linkedSteamId).toBe('76561190000000000');
  });

  it('passes an unparseable or non-object body through untouched — a simulation must never break a cycle', async () => {
    applySimulation(armedState('steam-account-mismatch'));
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    const res = await fetch('https://api.dmarket.com/exchange/v1/ext/heartbeat');
    await expect(res.text()).resolves.toBe('not json');
  });

  it('leaves a non-200 heartbeat alone (the error path is a different scenario)', async () => {
    applySimulation(armedState('steam-account-mismatch'));
    heartbeat({ linkedSteamId: 'x' });
    fetchMock.mockResolvedValue(new Response('{}', { status: 404 }));
    const res = await fetch('https://api.dmarket.com/exchange/v1/ext/heartbeat');
    expect(res.status).toBe(404);
  });
});

describe('simulatedReason — the switcher is authoritative while the master switch is on', () => {
  it('answers null with the master off (no opinion — mirror the core)', () => {
    applySimulation(DISARMED);
    expect(simulatedReason()).toBeNull();
  });

  it('answers the highest-RANKED armed state, not the first ticked one', () => {
    applySimulation(armedState('steam-account-mismatch', 'dm-session-missing'));
    expect(simulatedReason()).toBe('DM_SESSION_MISSING');
  });

  it('answers NONE for armed-but-empty — "everything is fine" is the operator\'s own assertion', () => {
    applySimulation(armedState());
    expect(simulatedReason()).toBe('NONE');
  });
});

describe('state parsing and residue', () => {
  it('parseSimulation is fail-safe on garbage', () => {
    // Asserted as equality to DISARMED, not as "enabled OR no scenarios": that disjunction covered the
    // whole space, so a parser that passed `{enabled:true, scenarios:['all']}` straight through would
    // have satisfied it — on the one guard a fail-safe parser of untrusted stored state has.
    for (const bad of [undefined, null, 'x', 42, { enabled: 'yes' }, { enabled: true, scenarios: 'all' }]) {
      expect(parseSimulation(bad)).toEqual(DISARMED);
    }
    expect(parseSimulation({ enabled: true, scenarios: ['dm-session-missing', 'bogus'] }).scenarios).toEqual([
      'dm-session-missing',
    ]);
  });

  it('effectiveSimulation reports what the WORKER has in effect, not what is persisted', () => {
    applySimulation(armedState('dm-connection-error'));
    expect(effectiveSimulation()).toEqual({ enabled: true, scenarios: ['dm-connection-error'] });
  });

  it('clearResidue removes only the loop keys of the scenarios being DISARMED', async () => {
    await browser.storage.local.set({
      loop_steam_session_missing: '1',
      loop_steam_mint_attempted: '1',
      loop_server_error_count: '2',
      loop_next_heartbeat_at_ms: '123', // core state no scenario owns — must survive
    });
    await clearResidue(
      parseSimulation(armedState('steam-session-missing', 'dm-connection-error')),
      parseSimulation(armedState('dm-connection-error')), // still armed → its residue stays
    );
    const left = await browser.storage.local.get(null);
    expect(left).toEqual({ loop_server_error_count: '2', loop_next_heartbeat_at_ms: '123' });
  });
});

describe('the freshness-mark injector (DMA-280)', () => {
  const HEARTBEAT = 'https://api.dmarket.com/exchange/v1/ext/heartbeat';
  const armedMark = {
    enabled: true,
    dealId: 'deal-1',
    steamTradeId: '744935517744884653',
    proveAfter: '2026-09-02T10:15:30Z',
  };
  const body = (deals: unknown[]) => JSON.stringify({ activeTracking: deals, ttlSeconds: 60 });

  const heartbeatAnswering = (deals: unknown[]) => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(body(deals), { status: 200, headers: { 'content-length': '999' } })),
    );
  };

  it('stamps the mark onto the named deal and leaves the others alone', async () => {
    heartbeatAnswering([{ dealId: 'deal-1', watch: ['GetTradeStatus'] }, { dealId: 'deal-2' }]);
    applyDemand(armedMark);

    const parsed = (await (await fetch(HEARTBEAT, { method: 'POST' })).json()) as {
      activeTracking: Record<string, unknown>[];
    };

    expect(parsed.activeTracking[0]).toMatchObject({
      dealId: 'deal-1',
      steamTradeId: '744935517744884653',
      proveAfter: '2026-09-02T10:15:30Z',
    });
    expect(parsed.activeTracking[1]).toEqual({ dealId: 'deal-2' });
    // The whole response has to survive: the core decodes the TTL and every other deal from the same body.
    expect((parsed as unknown as { ttlSeconds: number }).ttlSeconds).toBe(60);
  });

  it('says so when the heartbeat does not track the named deal, rather than no-opping silently', async () => {
    // A silent no-op here is indistinguishable from a client that ignores marks — the exact confusion this
    // whole feature had to be built to resolve, so the tool must not be able to reproduce it.
    heartbeatAnswering([{ dealId: 'someone-else' }]);
    applyDemand(armedMark);

    const parsed = (await (await fetch(HEARTBEAT, { method: 'POST' })).json()) as {
      activeTracking: Record<string, unknown>[];
    };

    expect(parsed.activeTracking[0]).toEqual({ dealId: 'someone-else' });
    expect(notes.some((n) => n.text.includes('does not track deal-1'))).toBe(true);
  });

  it('stamps nothing while incomplete or disarmed, and passes the body through untouched', async () => {
    for (const state of [
      { ...armedMark, enabled: false },
      { ...armedMark, steamTradeId: '' },
      { ...armedMark, proveAfter: '' },
    ]) {
      heartbeatAnswering([{ dealId: 'deal-1' }]);
      applyDemand(state);
      const parsed = (await (await fetch(HEARTBEAT, { method: 'POST' })).json()) as {
        activeTracking: Record<string, unknown>[];
      };
      expect(parsed.activeTracking[0]).toEqual({ dealId: 'deal-1' });
    }
  });

  it('re-stamps the SAME instant on every heartbeat', async () => {
    // The property the core's monotone latch depends on. A mark derived from `now` per heartbeat would be
    // greater every time, so the latch could never hold and the deal would re-prove on every wake —
    // reproducing, with a dev tool, the exact runaway the latch exists to prevent.
    applyDemand(armedMark);
    const marks: unknown[] = [];
    for (let i = 0; i < 3; i++) {
      heartbeatAnswering([{ dealId: 'deal-1' }]);
      const parsed = (await (await fetch(HEARTBEAT, { method: 'POST' })).json()) as {
        activeTracking: Record<string, unknown>[];
      };
      marks.push(parsed.activeTracking[0]?.['proveAfter']);
    }
    expect(marks).toEqual(['2026-09-02T10:15:30Z', '2026-09-02T10:15:30Z', '2026-09-02T10:15:30Z']);
  });

  it('reports what the worker is stamping, not merely what was asked for', () => {
    applyDemand({ ...armedMark, steamTradeId: 7 as unknown as string });
    // A malformed value parses to disarmed, and `effectiveDemand` must say THAT — the console reporting a
    // mark a failed parse never armed is the same lie `effectiveSimulation` exists to prevent.
    expect(effectiveDemand().enabled).toBe(false);
    applyDemand(armedMark);
    expect(effectiveDemand()).toEqual(armedMark);
  });

  it('does not touch a non-heartbeat request', async () => {
    applyDemand(armedMark);
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    const res = await fetch('https://api.steampowered.com/IEconService/GetTradeStatus/v1/');
    expect(await res.text()).toBe('{}');
  });
});
