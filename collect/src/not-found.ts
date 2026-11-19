// collect's 404 (dist/404.html): Pages serves it, with a 404 status, for any
// address nothing else answers. Static HTML, filled in at build time by the
// vite plugin in vite.config.ts; the /c/ map links have their own page
// (link-problem.ts) for a link that doesn't open a map.
import { collectTopbarHtml } from './topbar';

/** Where 404.html takes the page body. */
export const NOT_FOUND_SLOT = '<!-- NOT_FOUND -->';

export function notFoundHtml(): string {
  return `${collectTopbarHtml()}
    <div class="pad">
      <h1>There's nothing at this address</h1>
      <p class="hint">The address may have a typo, or the page has moved. If someone shared a map link with you, ask them for a fresh one.</p>
      <a class="btn primary" href="/">Make a map</a>
      <footer class="foot-note">
        <span>Part of <a href="https://bharatlas.com">bharatlas</a>. <a href="https://bharatlas.com/layers">Browse its layers</a>.</span>
      </footer>
    </div>`;
}

/** 404.html with its body filled in. */
export function renderNotFoundPage(template: string): string {
  return template.replace(NOT_FOUND_SLOT, notFoundHtml());
}
