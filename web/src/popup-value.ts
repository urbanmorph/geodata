// One value in a map pop-up. Photos from a collect map (published as links to
// collect.bharatlas.com) show as small pictures that open the full photo; every
// other value is escaped text.
import { escapeHtml } from './util';

const PHOTO = /^https:\/\/collect\.bharatlas\.com\/api\/collect\/v1\/photos\/ph_[A-Za-z0-9_-]{10,40}$/;

/** Collect photo links in a value: one link, a list, or a list as JSON text (tile attributes). */
export function collectPhotoUrls(v: unknown): string[] {
  let list: unknown = v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try { list = JSON.parse(v); } catch { return []; }
  }
  const items = Array.isArray(list) ? list : [list];
  return items.length && items.every((x) => typeof x === 'string' && PHOTO.test(x)) ? (items as string[]) : [];
}

export function popupValueHtml(v: unknown): string {
  const photos = collectPhotoUrls(v);
  if (!photos.length) return escapeHtml(String(v));
  return `<span class="geo-popup__photos">${photos.map((u, i) =>
    `<a href="${escapeHtml(u)}" target="_blank" rel="noopener"><img src="${escapeHtml(u)}" alt="Photo ${i + 1}" loading="lazy" width="72" height="72"></a>`).join('')}</span>`;
}
