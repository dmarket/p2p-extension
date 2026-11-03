import { useCallback, useEffect, useState } from 'preact/hooks';
import { getSettings } from '@/config/settings';
import type { BridgeRequest } from '@/messaging/protocol';
import {
  isGuardChangedPush,
  OFFER_VERDICTS_KIND,
  TRUST_PARTNER_KIND,
  type GuardResponse,
  type OfferDirection,
  type OfferLevel,
  type OfferVerdict,
  type OfferVerdictsRequest,
  type OfferVerdictsResponse,
  type TrustPartnerRequest,
} from '@/state/offerGuard';
import { accountId, isKnownScamPartner, OFFER_ID_PREFIX, pageLevel, scanSentOffers, type PageOffer } from './offerScan';
import {
  CHECK_TIMEOUT_MS,
  checkingVisible,
  isLandingPage,
  landingWarnings,
  offerBlockIds,
  offerPageId,
  offerPageWarning,
  verdictsRequest,
} from './offerPage';

export interface OfferWarning {
  offer: PageOffer;
  level: OfferLevel;
  direction: OfferDirection;
  /** See `OfferVerdict.byName`. */
  byName?: true;
}

const SENT_PAGE = /\/tradeoffers\/sent\/?$/;
/** The trade-offers landing page and the sent list: opening either asks the core for a fresh check. */
const CHECK_PAGE = /\/tradeoffers(\/sent)?\/?$/;

/** Only the sent page lists this account's outgoing offers; `?history=1` lists past ones. */
function sentPage(): { onSentPage: boolean; complete: boolean } {
  const onSentPage = SENT_PAGE.test(location.pathname);
  return { onSentPage, complete: onSentPage && !new URLSearchParams(location.search).has('history') };
}

/** What a stand-in block shows; stored on the block so a changed simulation redraws it. */
const standInKey = (v: OfferVerdict): string =>
  JSON.stringify([v.simulated?.personaName, v.partnerSteamId, v.giveCount, v.direction]);

/**
 * Debug builds only: draw a block for a simulated offer that Steam does not list, so the banner has something
 * to point at on an account with no offers. Shaped like Steam's own block, so the ordinary scan reads it; a
 * received one as the landing page draws an offer sent to the user.
 */
function insertStandIn(offerId: string, v: OfferVerdict): void {
  if (document.getElementById(`${OFFER_ID_PREFIX}${offerId}`) !== null || v.simulated === undefined) return;
  const el = (tag: string, cls: string, parent: Element): HTMLElement => {
    const e = document.createElement(tag);
    e.className = cls;
    parent.append(e);
    return e;
  };
  const block = document.createElement('div');
  block.className = 'tradeoffer';
  block.id = `${OFFER_ID_PREFIX}${offerId}`;
  block.dataset.dmpSimulated = standInKey(v);
  block.style.cssText = 'margin:12px 0;padding:12px;border:1px dashed #f5b83d;border-radius:4px;color:#c6d4df';
  const received = v.direction === 'received';
  const header = el('div', 'tradeoffer_header', block);
  if (!received) header.append('You offered ');
  el('span', '', header).textContent = v.simulated.personaName;
  header.append(
    `${received ? ' offered you' : ''} a trade: (simulated by the DMarket Trade Tracker debug console, not a real offer)`,
  );
  const ctn = el('div', 'tradeoffer_items_ctn', block);
  // The primary side is the sender's: the user's items on a sent offer, the partner's (none) on a received one.
  const primarySide = el('div', 'tradeoffer_items primary', ctn);
  const secondarySide = el('div', 'tradeoffer_items secondary', ctn);
  const given = el('div', 'tradeoffer_item_list', received ? secondarySide : primarySide);
  for (let i = 0; i < Math.max(1, v.giveCount); i++) {
    el('div', 'trade_item', given).style.cssText = 'display:inline-block;width:48px;height:36px;margin:2px;background:#3a3a3d';
  }
  // Steam puts the partner's avatar on the side they give from, even when that side is empty.
  const avatar = el('a', 'tradeoffer_avatar playerAvatar', el('div', 'tradeoffer_items_avatar_ctn', received ? primarySide : secondarySide));
  const miniprofile = accountId(v.partnerSteamId);
  // Not a number: the scan leaves the partner unknown.
  if (miniprofile !== undefined) avatar.dataset.miniprofile = miniprofile;
  const before = document.querySelector(getSettings().web.offerSelectors.offer);
  if (before?.parentElement) before.parentElement.insertBefore(block, before);
  // No offers at all: Steam's left column still holds the (empty) list.
  else (document.querySelector('.profile_leftcol') ?? document.querySelector(getSettings().web.bannerAnchorSelector) ?? document.body).append(block);
}

/**
 * Make the stand-in blocks match the simulated verdicts: drop the ones whose simulation was cleared or changed,
 * draw the missing ones. Touches the DOM only when something differs, since every change here wakes the page's
 * MutationObserver and with it another refresh. Returns whether it changed anything.
 */
export function syncStandIns(wanted: Record<string, OfferVerdict>): boolean {
  let changed = false;
  for (const el of document.querySelectorAll<HTMLElement>('[data-dmp-simulated]')) {
    const v = wanted[el.id.slice(OFFER_ID_PREFIX.length)];
    if (v?.simulated === undefined || el.dataset.dmpSimulated !== standInKey(v)) {
      el.remove();
      changed = true;
    }
  }
  for (const [id, v] of Object.entries(wanted)) {
    if (v.simulated === undefined || document.getElementById(`${OFFER_ID_PREFIX}${id}`) !== null) continue;
    insertStandIn(id, v);
    changed = true;
  }
  return changed;
}

/** The entries of [verdicts] on one of Steam's two lists. */
function ofDirection(verdicts: Record<string, OfferVerdict> | undefined, direction: OfferDirection): Record<string, OfferVerdict> {
  return Object.fromEntries(Object.entries(verdicts ?? {}).filter(([, v]) => v.direction === direction));
}

function hasVerdicts(reply: GuardResponse | undefined): reply is OfferVerdictsResponse {
  return reply?.ok === true && 'verdicts' in reply;
}

/** Impersonations first: they are the ones a user must not miss. */
function impersonationsFirst(a: OfferWarning, b: OfferWarning): number {
  return a.level === b.level ? 0 : a.level === 'IMPERSONATION' ? -1 : 1;
}

function ask(request: OfferVerdictsRequest | TrustPartnerRequest): Promise<GuardResponse | undefined> {
  return browser.runtime.sendMessage<OfferVerdictsRequest | TrustPartnerRequest, GuardResponse>(request).catch(() => undefined);
}

/**
 * The suspicious offers on this page, with the level to show: the core's verdict, raised to an impersonation
 * by this page's own name and known-account check. Re-read when the worker says the verdicts changed and when
 * Steam redraws the list. Asks the core for a sent-offers check once on mount, and says whether that check is
 * still running (`checking`). On a single offer's page (`offerId`) only that offer is asked about; on the landing
 * page only the received offers it lists, with no check of the page's own.
 */
export function useOfferWarnings(): {
  warnings: OfferWarning[];
  trust: (steamId: string) => void;
  checking: boolean;
  offerId: string | undefined;
} {
  const [warnings, setWarnings] = useState<OfferWarning[]>([]);
  const [checking, setChecking] = useState(false);
  const [offerId] = useState(() => offerPageId(location.pathname));
  const [openedAt] = useState(() => Date.now());
  const setIfChanged = useCallback(
    (next: OfferWarning[]) => setWarnings((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)),
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const knownScamPartners = getSettings().web.knownScamPartners ?? [];
    if (offerId !== undefined) {
      const reply = await ask(verdictsRequest([offerId]));
      if (!hasVerdicts(reply)) return;
      setChecking(checkingVisible({ ...reply, openedAt, now: Date.now() }));
      const w = offerPageWarning(offerId, reply.verdicts[offerId], knownScamPartners);
      const next = w === undefined ? [] : [w];
      setIfChanged(next);
      return;
    }
    const { offerSelectors } = getSettings().web;
    if (isLandingPage(location.pathname, location.search)) {
      let ids = offerBlockIds(document, offerSelectors);
      const reply = await ask(verdictsRequest(ids));
      if (!hasVerdicts(reply)) return;
      const verdicts = { ...reply.verdicts };
      if (import.meta.env.DEV) {
        Object.assign(verdicts, ofDirection(reply.simulated, 'received'));
        if (syncStandIns(ofDirection(verdicts, 'received'))) ids = offerBlockIds(document, offerSelectors);
      }
      const next = landingWarnings(ids, verdicts, knownScamPartners);
      next.sort(impersonationsFirst);
      setIfChanged(next);
      return;
    }
    const { onSentPage, complete } = sentPage();
    if (!onSentPage) return;
    let offers = scanSentOffers(document, offerSelectors);
    // What this page recognises on its own goes to the worker too, so the badge and the popup count it.
    const impersonations = offers.flatMap((o) =>
      o.partnerSteamId !== undefined && isKnownScamPartner(o, knownScamPartners)
        ? [{ offerId: o.offerId, partnerSteamId: o.partnerSteamId, giveCount: o.giveCount }]
        : [],
    );
    const reply = await ask({
      kind: OFFER_VERDICTS_KIND,
      offerIds: offers.map((o) => o.offerId),
      pageComplete: complete,
      impersonations,
    });
    const answered = hasVerdicts(reply);
    const verdicts = answered ? { ...reply.verdicts } : {};
    if (answered) setChecking(checkingVisible({ ...reply, openedAt, now: Date.now() }));
    // Only on an answer: a failed ask must not wipe the stand-ins of a simulation that is still on.
    if (import.meta.env.DEV && answered) {
      Object.assign(verdicts, ofDirection(reply.simulated, 'sent'));
      if (syncStandIns(ofDirection(verdicts, 'sent'))) offers = scanSentOffers(document, offerSelectors);
    }
    const next = offers.flatMap((offer) => {
      const verdict = verdicts[offer.offerId];
      const level = pageLevel(offer, verdict?.level, knownScamPartners);
      // The core's name comes from the Steam Web API; the page's own is read from an English sentence only.
      const personaName = verdict?.personaName ?? offer.personaName;
      return level === undefined ? [] : [{ offer: { ...offer, personaName }, level, direction: verdict?.direction ?? 'sent' }];
    });
    next.sort(impersonationsFirst);
    setIfChanged(next);
  }, [offerId, openedAt, setIfChanged]);

  useEffect(() => {
    // The core checks this account's sent offers now rather than at its next due cycle, at most every 30 s
    // (core DMA-818). Also from the landing page, where the user usually arrives: the badge then reflects it.
    // The offer's own page too: a scammer's direct link skips the list entirely.
    if (CHECK_PAGE.test(location.pathname) || offerId !== undefined) {
      void browser.runtime
        .sendMessage({ kind: 'request-cycle', reason: 'offers_page' } satisfies BridgeRequest)
        .catch(() => {});
    }
    if (!sentPage().onSentPage && offerId === undefined && !isLandingPage(location.pathname, location.search)) return undefined;
    void refresh();
    const timeout = setTimeout(() => setChecking(false), CHECK_TIMEOUT_MS - (Date.now() - openedAt));

    const onMessage = (message: unknown, sender: Browser.runtime.MessageSender): undefined => {
      if (isGuardChangedPush(message) && sender.id === browser.runtime.id && sender.tab === undefined) void refresh();
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);

    // Steam redraws the list after a cancel; our own host's shadow tree is invisible to this observer. The offer
    // page needs none: its offer is in the URL.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 500);
    });
    if (offerId === undefined) {
      observer.observe(document.querySelector(getSettings().web.bannerAnchorSelector) ?? document.body, {
        childList: true,
        subtree: true,
      });
    }
    return () => {
      clearTimeout(timer);
      clearTimeout(timeout);
      observer.disconnect();
      try {
        browser.runtime.onMessage.removeListener(onMessage);
      } catch {
        /* orphaned content script: the bindings are already gone */
      }
    };
  }, [refresh, offerId, openedAt]);

  const trust = useCallback(
    (steamId: string) => {
      setWarnings((prev) => prev.filter((w) => !(w.offer.partnerSteamId === steamId && w.level === 'UNLINKED_GIVE_ONLY')));
      void ask({ kind: TRUST_PARTNER_KIND, steamId }).then(() => refresh());
    },
    [refresh],
  );

  return { warnings, trust, checking, offerId };
}
