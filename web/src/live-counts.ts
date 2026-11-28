// Live download counts and useful votes from D1, patched into whatever the page
// shows: per-format counts on /layers rows, the home page's total, votes on
// community cards. Baked values stay if a fetch fails. Once per page load.
import { fmtCount } from './format-hints';

type Counts = Record<string, Record<string, number> | number>;

// One fetch per page: the load-time refresh and every /layers row that loads
// its links later (layer-downloads.ts) share it.
let counts: Promise<Counts | null> | null = null;
const liveCounts = (): Promise<Counts | null> =>
  (counts ??= fetch('/api/dl/counts')
    .then((r) => (r.ok ? (r.json() as Promise<Counts>) : null))
    .catch(() => null));

// Per-format badges, <span class="count" title="N downloads">N</span>, on the
// download links of one card with data-id="<layer_id>". The "compare sources"
// links are other layers', so they keep no count.
function patchCard(card: HTMLElement, all: Counts): void {
  const layerCounts = all[card.dataset.id || ''] as Record<string, number> | undefined;
  if (!layerCounts) return;
  for (const link of card.querySelectorAll<HTMLAnchorElement>('a[download]')) {
    if (link.closest('.alt')) continue;
    // The counted format: data-fmt on /layers rows, the link text on community cards.
    const fmt = link.dataset.fmt ?? link.textContent?.trim() ?? '';
    const n = layerCounts[fmt];
    if (!n) continue;
    const title = `${n.toLocaleString('en-IN')} downloads`;
    const badge = link.nextElementSibling?.nextElementSibling;
    if (badge?.classList.contains('count')) {
      badge.setAttribute('title', title);
      badge.textContent = fmtCount(n);
    } else {
      // No badge yet (was 0 at bake time): add one after the size span (link, size, count).
      const span = document.createElement('span');
      span.className = 'count';
      span.title = title;
      span.textContent = fmtCount(n);
      link.nextElementSibling?.insertAdjacentElement('afterend', span);
    }
  }
}

/** Patch the live counts into one card's links, e.g. a /layers row whose links just loaded. */
export function patchDownloadCounts(card: HTMLElement): Promise<void> {
  return liveCounts().then((all) => {
    if (all) patchCard(card, all);
  });
}

let liveCountsRequested = false;
export function refreshLiveCounts(): void {
  if (liveCountsRequested) return;
  liveCountsRequested = true;
  liveCounts().then((all) => {
    if (!all) return;
    for (const card of document.querySelectorAll<HTMLElement>('[data-id]')) patchCard(card, all);

    // Refill the search-meta running total from the live count. The baked value
    // is a build-time snapshot; #dl-total is its own slot so we replace just the
    // " · <count> downloads" part (the API queries sit in #api-total). The count
    // is built from a number, so innerHTML here is safe (no user input).
    const total = typeof all._total === 'number' ? all._total : 0;
    const slot = document.getElementById('dl-total');
    if (slot && total > 0) {
      slot.innerHTML = ` · <span class="search-meta__count">${fmtCount(total)}</span> downloads`;
    }
  }).catch(() => {});

  // Useful votes on community cards (only where there are any): patches each
  // .comm-card's 👍 N span so new votes show without a rebuild. Missing entries
  // mean 0 votes; leave the baked default alone.
  if (!document.querySelector('.comm-card[data-id]')) return;
  fetch('/api/c/useful-counts')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, number>>) : null))
    .then((counts) => {
      if (!counts) return;
      for (const card of document.querySelectorAll<HTMLElement>('.comm-card[data-id]')) {
        const id = card.dataset.id || '';
        const n = counts[id];
        if (n == null) continue;
        card.dataset.useful = String(n);
        const span = card.querySelector<HTMLElement>('.useful');
        if (span) span.textContent = `👍 ${n}`;
        const score = card.querySelector<HTMLElement>('.comm-card__score');
        if (score) score.title = `${n} found this useful`;
      }
    })
    .catch(() => {});
}
