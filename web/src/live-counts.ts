// Live download counts and useful votes from D1, patched into whatever the page
// shows: per-format counts on /layers rows, the home page's total, votes on
// community cards. Baked values stay if a fetch fails. Once per page load.
import { fmtCount } from './format-hints';

let liveCountsRequested = false;
export function refreshLiveCounts(): void {
  if (liveCountsRequested) return;
  liveCountsRequested = true;
  fetch('/api/dl/counts')
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, Record<string, number> | number>>) : null))
    .then((counts) => {
      if (!counts) return;

      // Patch per-format badges: <span class="count" title="N downloads">N</span>
      // Each download link lives inside a card with data-id="<layer_id>".
      // fmtCount lives in format-hints.ts (pure + unit-tested).
      for (const section of document.querySelectorAll<HTMLElement>('[data-id]')) {
        const layerId = section.dataset.id || '';
        const layerCounts = counts[layerId] as Record<string, number> | undefined;
        if (!layerCounts) continue;
        for (const link of section.querySelectorAll<HTMLAnchorElement>('a[download]')) {
          // The counted format: data-fmt on /layers rows, the link text on community cards.
          const fmt = link.dataset.fmt ?? link.textContent?.trim() ?? '';
          const n = layerCounts[fmt];
          if (!n) continue;
          const badge = link.nextElementSibling?.nextElementSibling;
          if (badge?.classList.contains('count')) {
            badge.setAttribute('title', `${n.toLocaleString('en-IN')} downloads`);
            badge.textContent = fmtCount(n);
          } else {
            // No badge yet (was 0 at bake time) — inject one.
            const span = document.createElement('span');
            span.className = 'count';
            span.title = `${n.toLocaleString('en-IN')} downloads`;
            span.textContent = fmtCount(n);
            // Insert after the size span (link → size-span → count-span)
            const sizeSpan = link.nextElementSibling;
            if (sizeSpan) sizeSpan.insertAdjacentElement('afterend', span);
          }
        }
      }

      // Refill the search-meta running total from the live count. The baked value
      // is a build-time snapshot; #dl-total is its own slot so we replace just the
      // " · <count> downloads" part (the API queries sit in #api-total). The count
      // is built from a number, so innerHTML here is safe (no user input).
      const total = typeof counts._total === 'number' ? counts._total : 0;
      const slot = document.getElementById('dl-total');
      if (slot && total > 0) {
        slot.innerHTML = ` · <span class="search-meta__count">${fmtCount(total)}</span> downloads`;
      }
    })
    .catch(() => {});

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
