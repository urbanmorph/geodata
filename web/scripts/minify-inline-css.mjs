// Minify each page's inline <style> blocks at prerender time. Vite's HTML build leaves inline CSS
// as written, and on /layers it was a sixth of the gzipped page. Only the CSS text changes.
import { transformWithEsbuild } from 'vite';

const STYLE = /(<style[^>]*>)([\s\S]*?)(<\/style>)/g;
const ROOT_BLOCK = /:root\s*\{([^{}]*)\}/g;
const DECL = /(--[\w-]+)\s*:\s*([^;]*)(;|$)/g;
const refsIn = (text) => [...text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);

/**
 * Drop the :root custom properties a page never reads. Every page carries the
 * whole token set (shared/tokens.mjs); each keeps only what its own CSS, its
 * markup and `alsoUsed` (tokens the site's scripts read) refer to, directly or
 * through another kept token.
 */
export function pruneUnusedTokens(html, alsoUsed = new Set()) {
  const declared = new Map();
  for (const [, body] of html.matchAll(ROOT_BLOCK)) for (const [, name, value] of body.matchAll(DECL)) declared.set(name, value);
  const used = new Set([...alsoUsed, ...refsIn(html.replace(ROOT_BLOCK, ''))]);
  const queue = [...used];
  while (queue.length) {
    for (const ref of refsIn(declared.get(queue.pop()) ?? '')) if (!used.has(ref)) { used.add(ref); queue.push(ref); }
  }
  return html.replace(ROOT_BLOCK, (block, body) =>
    block.replace(body, body.replace(DECL, (decl, name) => (used.has(name) ? decl : ''))));
}

/** `keepTokens`: prune unused :root tokens first, keeping these names. */
export async function minifyInlineStyles(html, { keepTokens } = {}) {
  if (keepTokens) html = pruneUnusedTokens(html, keepTokens);
  const blocks = [...html.matchAll(STYLE)];
  if (!blocks.length) return html;
  const minified = await Promise.all(blocks.map(([, , css]) =>
    transformWithEsbuild(css, 'inline.css', { loader: 'css', minify: true }).then((r) => r.code)));
  let i = 0;
  return html.replace(STYLE, (_, open, _css, close) => open + minified[i++] + close);
}
