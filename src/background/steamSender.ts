import { STEAM_INTEGRATION } from '@/config/steam';

const STEAM_ORIGIN = new URL(STEAM_INTEGRATION.communityUrl).origin;

/** This extension's own content script, on a Steam community tab — where the banner is injected. */
export function fromSteamTab(sender: Browser.runtime.MessageSender): boolean {
  if (sender.id !== browser.runtime.id) return false;
  try {
    return new URL(sender.tab?.url ?? '').origin === STEAM_ORIGIN;
  } catch {
    return false;
  }
}
