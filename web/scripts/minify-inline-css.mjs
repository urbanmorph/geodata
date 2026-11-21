// Minify each page's inline <style> blocks at prerender time. Vite's HTML build leaves inline CSS
// as written, and on /layers it was a sixth of the gzipped page. Only the CSS text changes.
import { transformWithEsbuild } from 'vite';

const STYLE = /(<style[^>]*>)([\s\S]*?)(<\/style>)/g;

export async function minifyInlineStyles(html) {
  const blocks = [...html.matchAll(STYLE)];
  if (!blocks.length) return html;
  const minified = await Promise.all(blocks.map(([, , css]) =>
    transformWithEsbuild(css, 'inline.css', { loader: 'css', minify: true }).then((r) => r.code)));
  let i = 0;
  return html.replace(STYLE, (_, open, _css, close) => open + minified[i++] + close);
}
