// collect's header: its name, then the bharatlas mark linking to the atlas.
// One definition for the landing, the link-problem page and the 404.
import { wordmarkHtml } from '../../shared/brand.mjs';

export function collectTopbarHtml(): string {
  return `<div class="topbar"><span class="collect-name">collect</span>${wordmarkHtml({ href: 'https://bharatlas.com', className: 'brand', size: 18 })}</div>`;
}
