// The site footer, one definition for every surface: the prerendered pages
// (via web/scripts/shared-chrome.mjs), the community layer pages (/c/<id>),
// /submit (a standalone page; web/tests/shared-footer.test.ts keeps its copy
// identical) and collect's home (absolute links). Add a link here once.
import { escapeHtml as esc } from './format.mjs';

const SITE = 'https://bharatlas.com';

// [label, href]; a leading "/" is a bharatlas.com page.
const LINKS = [
  ['privacy', '/privacy'],
  ['terms', '/terms'],
  ['status', 'https://status.bharatlas.com/'],
  ['code', 'https://github.com/urbanmorph/geodata'],
];

const DEFAULT_NOTE = 'Open licences only. Each layer carries its source link on the card.';

/** The links line. `absolute` for pages on another host (collect). */
export function footerLinksHtml({ absolute = false } = {}) {
  const link = ([label, href]) => `<a href="${absolute && href.startsWith('/') ? SITE + href : href}">${label}</a>`;
  return `${LINKS.map(link).join(' · ')} · made by <a href="https://urbanmorph.com">urbanmorph</a> · a digital commons · <a href="https://pdgi.org">pdgi.org</a>`;
}

/** The whole footer: a note (page-specific, or the default) above the links. */
export function footerHtml({ note = DEFAULT_NOTE } = {}) {
  return `<footer class="site-footer"><p>${esc(note)}</p><p>${footerLinksHtml()}</p></footer>`;
}
