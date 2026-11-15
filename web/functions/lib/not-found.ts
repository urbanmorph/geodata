// The 404 page for every edge route (unknown page, layer, submission):
// branded, noindex, light and dark.
import { THEME } from '../../../shared/brand.mjs';
import { escapeHtml as esc } from '../../../shared/format.mjs';

const L = THEME.light;
const D = THEME.dark;
const CSS =
  `:root{color-scheme:light dark}body{font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:${L['--fg']};background:#fff}` +
  `h1{font-size:22px;margin:0 0 8px}a{color:${L['--accent']}}` +
  `@media(prefers-color-scheme:dark){body{color:${D['--fg']};background:#0a0a0a}a{color:${D['--accent']}}}`;

export function notFoundHtml(what: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Not found · bharatlas</title><meta name="robots" content="noindex"><style>${CSS}</style></head>` +
    `<body><h1>404: ${esc(what)}</h1><p>${esc(message)}</p><p><a href="/">Back to all layers</a></p></body></html>`;
}
