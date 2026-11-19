// @vitest-environment happy-dom
// "Copy" on a link (create-success screen, Manage → Share). The clipboard call
// runs in the tap itself (iOS drops it after an await). The ✓ shows only when
// the browser actually copied; a refusal says so and suggests long-pressing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { shareItemHtml, wireShareItems } from '../src/share-ui';

const URL_ = 'https://collect.bharatlas.com/c/mapabc#edt_1';
const flush = () => new Promise((r) => setTimeout(r, 0));
const toastText = () => document.querySelector('.toast')?.textContent ?? '';

function mount(): HTMLButtonElement {
  document.body.innerHTML = `<div id="root">${shareItemHtml('collect', 'Collect link', URL_)}</div>`;
  wireShareItems(document.getElementById('root')!, 'Trees');
  return document.querySelector<HTMLButtonElement>('[data-act="copy"]')!;
}

describe('Copy', () => {
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => setTimeout(f, 0)); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('calls the clipboard within the tap, and shows ✓ once it is copied', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const b = mount();
    b.click();
    expect(writeText).toHaveBeenCalledWith(URL_); // synchronously, in the tap
    await flush();
    expect(b.textContent).toBe('✓');
    expect(toastText()).toMatch(/copied/i);
  });

  it('when the browser refuses, no ✓: a message says to long-press the link', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    const b = mount();
    b.click();
    await flush();
    expect(b.textContent).toBe('Copy');
    expect(toastText()).toMatch(/Couldn't copy, long-press the link/);
  });

  it('where there is no clipboard at all, says the same', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const b = mount();
    b.click();
    await flush();
    expect(b.textContent).toBe('Copy');
    expect(toastText()).toMatch(/Couldn't copy/);
  });
});
