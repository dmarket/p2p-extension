/**
 * Send `message` to every tab matching `url`. Best-effort: a tab without our content script, or one closed
 * meanwhile, just rejects, and a failed query sends nothing.
 */
export async function broadcastToTabs(url: string[], message: unknown): Promise<void> {
  try {
    const tabs = await browser.tabs.query({ url });
    const ids = tabs.map((t) => t.id).filter((id): id is number => id !== undefined);
    await Promise.all(ids.map((id) => browser.tabs.sendMessage(id, message).catch(() => {})));
  } catch {
    /* no matching tabs / query failed */
  }
}
