// The 404 page (dist/404.html): 404.template.html in the shared chrome. Cloudflare
// Pages serves it, with a 404, for any path no file or Function answers; the edge
// Functions read it and fill its NF_TITLE / NF_MESSAGE / NF_EXTRA regions
// (functions/lib/not-found.ts). Emitted by vite.config.ts at build time rather than
// prerendered into web/, so it leaves no generated file in the tree. No /src entry:
// it's served as written, so the header skips the install script.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKENS, renderNav, FOOTER } from './shared-chrome.mjs';
import { fillTemplate } from './fill-template.mjs';

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '404.template.html');

export function renderNotFoundPage() {
  return fillTemplate(readFileSync(TEMPLATE, 'utf8'), { TOKENS, NAV: renderNav('', { installScript: false }), FOOTER });
}
