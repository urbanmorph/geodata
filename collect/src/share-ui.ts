// The DOM for handing a link to another device: a labelled link with Copy,
// Share (native sheet), and QR. Shared by the create-success screen (landing)
// and the admin Share tab (app) so the two never drift. Pure string builders +
// event wiring; the encoder and share/clipboard calls live in qr.ts / share.ts.

import { escapeHtml } from './util';
import { shareOrCopy } from './share';
import { qrSvg } from './qr';

// One link block. `key` disambiguates items; `note` is an optional caption.
export function shareItemHtml(key: string, label: string, url: string, note?: string): string {
  return `<div class="share-item" data-share="${escapeHtml(key)}">
    <div class="share-item__label"><span>${escapeHtml(label)}</span></div>
    <code>${escapeHtml(url)}</code>
    <div class="share-item__actions">
      <button type="button" data-act="copy">Copy</button>
      <button type="button" data-act="share">⇪ Share</button>
      <button type="button" data-act="qr" aria-expanded="false">▦ QR</button>
    </div>
    <div class="qr-slot" hidden></div>
    ${note ? `<p class="hint" style="margin:8px 0 0">${escapeHtml(note)}</p>` : ''}
  </div>`;
}

// Toggle a QR under a link. The encoder loads on first use (dynamic import), so
// show a spinner while it arrives.
export async function toggleQr(slot: HTMLElement, url: string): Promise<void> {
  if (!slot.hasAttribute('hidden')) {
    slot.setAttribute('hidden', '');
    slot.innerHTML = '';
    return;
  }
  slot.removeAttribute('hidden');
  slot.innerHTML = '<div class="qr"><span class="spinner"></span></div>';
  try {
    slot.innerHTML =
      `<div class="qr">${await qrSvg(url)}</div>` +
      `<p class="hint" style="text-align:center;margin:6px 0 0">Point a phone camera here to open on another device.</p>`;
  } catch {
    slot.innerHTML = '<p class="hint">Could not draw the QR code.</p>';
  }
}

// Wire Copy / Share / QR for every .share-item under root. The URL is read from
// each item's own <code>, so callers only build the HTML.
export function wireShareItems(root: ParentNode, title: string): void {
  root.querySelectorAll<HTMLElement>('.share-item').forEach((item) => {
    const url = item.querySelector('code')?.textContent || '';
    const copy = item.querySelector<HTMLButtonElement>('[data-act="copy"]');
    if (copy) copy.onclick = () => {
      void navigator.clipboard?.writeText(url).catch(() => {});
      copy.textContent = '✓';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
    };
    const share = item.querySelector<HTMLButtonElement>('[data-act="share"]');
    if (share) share.onclick = () => { void shareOrCopy(url, title); };
    const qrBtn = item.querySelector<HTMLButtonElement>('[data-act="qr"]');
    const slot = item.querySelector<HTMLElement>('.qr-slot');
    if (qrBtn && slot) qrBtn.onclick = () => {
      void toggleQr(slot, url);
      qrBtn.setAttribute('aria-expanded', slot.hasAttribute('hidden') ? 'false' : 'true');
    };
  });
}
