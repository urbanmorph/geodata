// Home hero helpers: the quick-search line and "Open a file".
//
// Quick searches: prerender writes the whole pool; CSS clips the row to one
// line (flex-wrap in a fixed-height box), so whatever fits shows whole and
// the rest wraps out of sight. Here the pills are shuffled once and the
// wrapped ones are made inert, so they are neither focusable nor read out.

/** Fisher-Yates shuffle, in place. */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** How many leading items sit on the first line, from their offsetTop values. */
export function firstLineCount(tops: number[]): number {
  let n = 0;
  while (n < tops.length && Math.abs(tops[n] - tops[0]) < 1) n++;
  return n;
}

/** Shuffle the pills (the label stays first), then keep only the first line reachable; again on resize. */
export function fitQuickSearch(nav: HTMLElement, random?: () => number): void {
  const pills = shuffle(Array.from(nav.querySelectorAll<HTMLAnchorElement>('a')), random);
  for (const a of pills) nav.appendChild(a);
  const fit = () => {
    const n = firstLineCount(pills.map((a) => a.offsetTop));
    pills.forEach((a, i) => a.toggleAttribute('inert', i >= n));
  };
  fit();
  nav.setAttribute('data-ready', '');
  if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(nav);
}

/**
 * "Open a file": the link (to /preview, for no-JS) opens the file picker
 * straight from the click, which a picker needs, and hands the file on.
 */
export function wireOpenFile(link: HTMLAnchorElement, input: HTMLInputElement, open: (file: File) => void): void {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    input.value = '';
    input.click();
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) open(file);
  });
}
