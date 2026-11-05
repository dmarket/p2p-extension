import { parseHTML } from 'linkedom';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackButton } from './BackButton';

describe('BackButton', () => {
  const { document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const root = document.getElementById('root')!;
  vi.stubGlobal('document', document);
  afterEach(() => render(null, root));

  it('is a button named Back with a decorative icon, and clicking calls the handler', async () => {
    const onClick = vi.fn();
    await act(() => render(<BackButton onClick={onClick} />, root));
    const button = root.querySelector('button')!;
    expect(button.textContent?.trim()).toBe('Back');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.querySelector('img')?.getAttribute('alt')).toBe('');
    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
