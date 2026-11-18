// The browser side of shared/large-load.mjs: the card the map shows before a
// large whole-file load, and the speed rule on View map buttons. Speed comes from
// navigator.connection where the browser reports it (Chrome, Android); Safari
// reports none, so there the size rule alone applies.
import { escapeHtml as esc, fmtBytes } from '../../shared/format.mjs';

export { LARGE_BYTES, SLOW_SECONDS, loadCost, type LoadCost } from '../../shared/large-load.mjs';
import { loadCost, LARGE_ICON, LARGE_VIEW_LABEL, largeViewNote, type LoadCost } from '../../shared/large-load.mjs';

const fmtTime = (s: number) => (s < 60 ? `about ${Math.max(1, Math.round(s))} s` : `about ${Math.round(s / 60)} min`);

/** The card shown in place of the map until the reader chooses. */
export function largeLoadHtml(cost: LoadCost, downloadUrl: string): string {
  const size = cost.bytes ? fmtBytes(cost.bytes) : 'a large file';
  const time = cost.seconds !== null ? `, ${fmtTime(cost.seconds)} on this connection` : '';
  return `<div class="large-load" role="dialog" aria-labelledby="large-load-title">` +
    `<p class="large-load__title" id="large-load-title">This map draws from one ${esc(size)} file${esc(time)}.</p>` +
    `<p class="large-load__hint">It loads in full before anything shows. On a phone or a slow connection, downloading it may suit you better.</p>` +
    `<div class="large-load__actions"><button type="button" class="btn btn--fill" data-load>Load it</button>` +
    `<a class="btn btn--line" href="${esc(downloadUrl)}" download>Download instead</a></div></div>`;
}

type Connection = { downlink?: number };
const downlink = () => (navigator as Navigator & { connection?: Connection }).connection?.downlink;

/** Resolves true to load now; stays pending (the card remains) if the reader downloads instead. */
export function confirmLargeLoad(container: HTMLElement, bytes: number | null | undefined, downloadUrl: string): Promise<boolean> {
  const cost = loadCost(bytes, downlink());
  clearLargeLoad(container); // a card left from an earlier layer must not load it later
  if (!cost.large) return Promise.resolve(true);
  const holder = document.createElement('div');
  holder.innerHTML = largeLoadHtml(cost, downloadUrl);
  const card = holder.firstElementChild as HTMLElement;
  container.appendChild(card);
  return new Promise((done) => {
    card.querySelector('[data-load]')?.addEventListener('click', () => { card.remove(); done(true); });
  });
}

/** Remove any open card (a new layer opens, or the map closes); its promise is dropped unresolved. */
export function clearLargeLoad(container: Document | Element): void {
  container.querySelectorAll('.large-load').forEach((el) => el.remove());
}

/** The speed rule on View map links the build marked with data-load-bytes: a file
 *  small enough for the size rule can still be slow on this connection. */
export function markLargeViews(root: Document | Element): void {
  const mbps = downlink();
  if (!mbps) return;
  // Buttons only: inline links (alternate sources) keep their own text.
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a.btn-primary[data-load-bytes]')) {
    const bytes = Number(a.dataset.loadBytes);
    const base = a.classList[0];
    if (!base || a.classList.contains(`${base}--large`) || !loadCost(bytes, mbps).large) continue;
    a.classList.add(`${base}--large`);
    const note = largeViewNote(bytes);
    a.title = note;
    a.setAttribute('aria-label', `${LARGE_VIEW_LABEL}: ${note.charAt(0).toLowerCase()}${note.slice(1)}`);
    a.innerHTML = LARGE_ICON + LARGE_VIEW_LABEL;
  }
}
