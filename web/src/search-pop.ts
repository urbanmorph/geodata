// The home search's results popover (the mockup): matching layers under the
// bar, keyboard-navigable, with the ward answer above them. Pure helpers here;
// main.ts owns the DOM. Each card carries data-title / data-sub / data-href.
import { escapeHtml as esc } from './util';

export type Hit = { title: string; sub: string; href: string };

/** Every match for a query, on the All layers page. */
export const allLayersUrl = (q: string): string => `/layers?q=${encodeURIComponent(q)}`;

/** "/" focuses the search box from anywhere on the page (not while typing). */
export function focusOnSlash(input: HTMLInputElement): void {
  document.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key !== '/' || e.metaKey || e.ctrlKey || t.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    input.focus();
  });
}

/** Matching cards, titles that contain the query first, then catalogue order. */
export function rankHits(cards: Hit[], matches: boolean[], query: string, n: number): Hit[] {
  const q = query.trim().toLowerCase();
  const hit = cards.filter((_, i) => matches[i]);
  const inTitle = (h: Hit) => q !== '' && h.title.toLowerCase().includes(q);
  return [...hit.filter(inTitle), ...hit.filter((h) => !inTitle(h))].slice(0, n);
}

const ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/></svg>';

/** Options for the listbox, and a link to the full filtered list when there are more. */
export function hitsHtml(hits: Hit[], total: number, query: string): string {
  if (!hits.length) return `<p class="search-pop__head">No layer matches "${esc(query)}"</p>`;
  const items = hits
    .map((h, i) =>
      `<a class="search-hit" role="option" id="search-hit-${i}" aria-selected="false" href="${esc(h.href)}">` +
      `<span class="search-hit__ico">${ICON}</span><span class="search-hit__text"><span class="search-hit__title">${esc(h.title)}</span>` +
      `<span class="search-hit__sub">${esc(h.sub)}</span></span></a>`)
    .join('');
  const more = total > hits.length ? `<a class="search-pop__all" href="${esc(allLayersUrl(query))}">See all ${total} matching layers</a>` : '';
  return `<p class="search-pop__head">Layers</p>${items}${more}`;
}

/** Next highlighted option for an arrow key, wrapping; -1 is none. */
export function moveActive(i: number, key: string, count: number): number {
  if (count === 0) return -1;
  if (key === 'ArrowDown') return i < 0 || i >= count - 1 ? 0 : i + 1;
  if (key === 'ArrowUp') return i <= 0 ? count - 1 : i - 1;
  return i;
}
