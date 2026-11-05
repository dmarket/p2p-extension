/** Last resort for a context where the async Clipboard API is refused. Synchronous, so it keeps the click's activation. */
function copyWithTextarea(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } finally {
    area.remove();
  }
}

/** Puts `text` on the clipboard; rejects when neither the Clipboard API nor the textarea fallback works. */
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    if (!copyWithTextarea(text)) throw new Error('copy refused');
  }
}
