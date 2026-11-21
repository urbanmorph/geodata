// The 404 page for every edge route (unknown page, layer, submission). The themed
// page is the deployment's own dist/404.html (scripts/not-found-page.mjs: site
// header, logo, footer, search), read once per isolate through env.ASSETS and
// filled in here. If it can't be read, a small inline page stands in.
import { COLORS, FONT, FONT_SIZE } from '../../../shared/tokens.mjs';
import { escapeHtml as esc } from '../../../shared/format.mjs';
import { fetchAsset, type AssetCtx } from './catalog-loader';
import { SECURITY_HEADERS_HTML } from './security-headers';

export type NotFound = {
  title: string;
  message: string;
  /** Trusted HTML the caller built (and escaped). */
  extra?: string;
};

// Small on purpose: the token values it needs, written in, not the whole set.
const L = COLORS.light;
const D = COLORS.dark;
const CSS =
  `:root{color-scheme:light dark}body{font:${FONT_SIZE['--fs-base']}/1.6 ${FONT['--font-sans']};max-width:600px;margin:80px auto;padding:0 24px;color:${L['--fg']};background:${L['--bg']}}` +
  `h1{font-size:${FONT_SIZE['--fs-xl']};margin:0 0 8px}a{color:${L['--accent']}}` +
  `@media(prefers-color-scheme:dark){body{color:${D['--fg']};background:${D['--bg']}}a{color:${D['--accent']}}}`;

/** The inline fallback, for when dist/404.html can't be read. */
export function notFoundHtml(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Page not found · bharatlas</title><meta name="robots" content="noindex"><style>${CSS}</style></head>` +
    `<body><h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/layers">All layers</a> · <a href="/">Home</a></p></body></html>`;
}

// Each region is <!-- NF_X -->default<!-- /NF_X -->, so the page reads right unfilled
// (Pages serving it for a static miss) and the edge can swap the default out.
const REGION = /<!-- (NF_TITLE|NF_MESSAGE|NF_EXTRA) -->[\s\S]*?<!-- \/\1 -->/g;

/** The shell with its regions replaced: title and message as text, extra as HTML. */
export function fillNotFound(shell: string, { title, message, extra = '' }: NotFound): string {
  const values: Record<string, string> = { NF_TITLE: esc(title), NF_MESSAGE: esc(message), NF_EXTRA: extra };
  return shell.replace(REGION, (_m, name: string) => values[name]);
}

/** Edit distance (Levenshtein), two rows. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Up to `n` layer ids closest to a mistyped one: ids that start with it (or that
 *  it starts with) first, then ids containing it or within a few edits, nearest first. */
export function suggestLayers(id: string, layers: ReadonlyArray<{ id: string }>, n = 3): string[] {
  const q = id.toLowerCase();
  const maxEdits = Math.max(2, Math.floor(q.length / 3));
  return layers
    .map(({ id: cand }) => {
      const c = cand.toLowerCase();
      const d = distance(q, c);
      const prefix = c.startsWith(q) || q.startsWith(c);
      return { cand, score: prefix ? d - 100 : d, ok: prefix || c.includes(q) || d <= maxEdits };
    })
    .filter((s) => s.ok)
    .sort((a, b) => a.score - b.score || a.cand.localeCompare(b.cand))
    .slice(0, n)
    .map((s) => s.cand);
}

const MARKER = '<!-- NF_TITLE -->';
let shell: Promise<string> | null = null;

/** dist/404.html, once per isolate (it changes only with a deploy). A failed or
 *  wrong read (no regions in it) is dropped, so the next request tries again. */
function loadShell(ctx: AssetCtx): Promise<string> {
  if (!shell) {
    shell = fetchAsset(ctx, '/404.html')
      .then((r) => r.text())
      .then((t) => {
        if (!t.includes(MARKER)) throw new Error('404.html has no regions');
        return t;
      });
    shell.catch(() => { shell = null; });
  }
  return shell;
}

export function __resetNotFoundForTest(): void {
  shell = null;
}

/** A 404 with the themed page (or the inline one), noindex, security headers. */
export async function notFoundResponse(ctx: AssetCtx, page: NotFound, headers: Record<string, string> = {}): Promise<Response> {
  const html = await loadShell(ctx).then(
    (s) => fillNotFound(s, page),
    () => notFoundHtml(page.title, page.message),
  );
  return new Response(html, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS_HTML, ...headers },
  });
}
