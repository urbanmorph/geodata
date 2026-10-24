// The Photo question on a form: thumbnails, Take photo (the camera) and From
// gallery, up to the question's limit. Each photo is made ready on the phone
// (prepare.ts) as soon as it is chosen; nothing is sent from here, the point's
// queue sends photos with it. Also the full-screen viewer, and private photos
// (pending points) shown with the admin's or contributor's token.
import { escapeHtml } from '../util';
import { newClientId } from '../outbox';
import { preparePhoto, mayShowFace, type PhotoMeta } from './prepare';
import type { Field } from '../schema/validate-record';

export interface PhotoItem {
  client_id: string;
  meta: PhotoMeta;
  url: string;   // what the thumbnail shows (a blob: URL, or the server's link)
  bytes?: ArrayBuffer; // a new photo, not sent yet
  id?: string;   // a photo already on the server
}

export interface PhotoFieldOptions {
  dataSaver: boolean;
  /** Photos the point already has (record editor), with the token to show them. */
  initial?: Array<{ id: string; url: string }>;
  token?: string;
  /** False where new photos can't be uploaded (a contributor's edit link). */
  canAdd?: boolean;
  onAdded?: (item: PhotoItem) => void;
  onError?: (message: string) => void;
}

export interface PhotoField {
  field: Field;
  items(): PhotoItem[];
  busy(): boolean;
}

/** One Photo question's photos. */
export function mountPhotoField(host: HTMLElement, field: Field, opts: PhotoFieldOptions): PhotoField {
  const max = field.max_photos ?? 3;
  const items: PhotoItem[] = (opts.initial ?? []).map((p) => ({ client_id: p.id, id: p.id, url: '', meta: {} }));
  const faces = new Set<string>();
  let preparing = 0;
  // Server photos need the token (private until approved): fetched, then shown.
  for (const [i, p] of (opts.initial ?? []).entries()) {
    const item = items[i]; // the photo itself, not its place: one may be removed meanwhile
    void authedSrc(p.url, opts.token).then((src) => { item.url = src; render(); });
  }
  const room = (): boolean => items.length + preparing < max;

  function render(): void {
    const canAdd = opts.canAdd !== false && room();
    host.innerHTML = `
      <div class="photos">
        ${items.map((p, i) => `<div class="photo-thumb">
          ${p.url ? `<button type="button" class="photo-open" data-open="${i}" aria-label="Photo ${i + 1}, open full screen"><img src="${escapeHtml(p.url)}" alt=""></button>` : '<span class="spinner"></span>'}
          <button type="button" class="photo-rm" data-rm="${i}" aria-label="Remove photo ${i + 1}">✕</button>
        </div>`).join('')}
        ${preparing ? '<div class="photo-thumb photo-thumb--wait"><span class="spinner"></span></div>' : ''}
        ${canAdd ? `
          <label class="photo-add">📷 Take photo<input type="file" accept="image/*" capture="environment" data-src="camera" hidden></label>
          <label class="photo-add photo-add--quiet">From gallery<input type="file" accept="image/*" data-src="gallery" hidden></label>` : ''}
      </div>
      <p class="hint">${max === 1 ? '1 photo' : `Up to ${max} photos`}. Keep faces and number plates out of the frame.</p>
      ${items.some((p) => faces.has(p.client_id)) ? '<p class="warn">A photo may show a face. Please retake it without people, or remove it.</p>' : ''}`;
    host.querySelectorAll<HTMLInputElement>('input[type=file]').forEach((input) => {
      input.onchange = () => {
        const file = input.files?.[0];
        if (file) void add(file, input.dataset.src as 'camera' | 'gallery');
      };
    });
    host.querySelectorAll<HTMLButtonElement>('[data-rm]').forEach((b) => {
      b.onclick = () => {
        const [gone] = items.splice(Number(b.dataset.rm), 1);
        if (gone?.bytes) URL.revokeObjectURL(gone.url);
        render();
      };
    });
    host.querySelectorAll<HTMLButtonElement>('[data-open]').forEach((b) => {
      b.onclick = () => openViewer(items.map((p) => p.url).filter(Boolean), Number(b.dataset.open));
    });
  }

  async function add(file: File, source: 'camera' | 'gallery'): Promise<void> {
    if (!room()) return;
    preparing++;
    render();
    try {
      const { bytes, blob, meta } = await preparePhoto(file, { dataSaver: opts.dataSaver, source });
      const item: PhotoItem = { client_id: newClientId(), bytes, meta, url: URL.createObjectURL(blob) };
      items.push(item);
      if (await mayShowFace(blob)) faces.add(item.client_id);
      opts.onAdded?.(item);
    } catch (e) {
      opts.onError?.((e as Error).message);
    } finally {
      preparing--;
      render();
    }
  }

  render();
  return { field, items: () => items.slice(), busy: () => preparing > 0 };
}

// ── private photos, and the full-screen viewer ─────────────────────────────

// The last few private photos, kept in memory; older ones are let go, so
// reviewing hundreds of points doesn't fill a phone's memory.
const srcCache = new Map<string, Promise<string>>();
const KEEP = 40;

/** An <img> src for a photo: public ones as they are; private ones fetched
 *  with the token (it can't ride in the URL) and shown from memory. */
export function authedSrc(url: string, token?: string): Promise<string> {
  if (!token) return Promise.resolve(url);
  let p = srcCache.get(url);
  if (p) srcCache.delete(url); // most recently used goes last
  else {
    p = fetch(url, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => URL.createObjectURL(b));
    p.catch(() => srcCache.delete(url));
  }
  srcCache.set(url, p);
  while (srcCache.size > KEEP) {
    const [oldest, gone] = srcCache.entries().next().value!;
    srcCache.delete(oldest);
    void gone.then((u) => URL.revokeObjectURL(u), () => {});
  }
  return p.catch(() => '');
}

/** Photos full screen: swipe-free buttons (Previous / Next / Close) and the keyboard. */
export function openViewer(urls: string[], start = 0): void {
  if (!urls.length) return;
  let i = Math.max(0, Math.min(start, urls.length - 1));
  const back = document.activeElement as HTMLElement | null;
  const el = document.createElement('div');
  el.className = 'viewer';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Photo');
  const draw = (): void => {
    el.innerHTML = `<img src="${escapeHtml(urls[i])}" alt="Photo ${i + 1} of ${urls.length}">
      <div class="viewer__bar">
        ${urls.length > 1 ? `<button type="button" data-v="prev" aria-label="Previous photo"${i === 0 ? ' disabled' : ''}>‹</button><span>${i + 1} / ${urls.length}</span><button type="button" data-v="next" aria-label="Next photo"${i === urls.length - 1 ? ' disabled' : ''}>›</button>` : ''}
        <button type="button" data-v="close" aria-label="Close">Close</button>
      </div>`;
    el.querySelector<HTMLButtonElement>('[data-v="close"]')!.focus();
  };
  const close = (): void => { el.remove(); document.removeEventListener('keydown', key); back?.focus(); };
  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft' && i > 0) { i--; draw(); }
    else if (e.key === 'ArrowRight' && i < urls.length - 1) { i++; draw(); }
  };
  el.addEventListener('click', (e) => {
    const v = (e.target as HTMLElement).closest<HTMLElement>('[data-v]')?.dataset.v;
    if (v === 'close' || e.target === el) close();
    else if (v === 'prev' && i > 0) { i--; draw(); }
    else if (v === 'next' && i < urls.length - 1) { i++; draw(); }
  });
  document.addEventListener('keydown', key);
  document.body.appendChild(el);
  draw();
}
