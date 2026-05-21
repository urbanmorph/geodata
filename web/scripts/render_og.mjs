// Render an SVG file to a flat PNG using headless Chromium.
//
// Usage:
//   node scripts/render_og.mjs <svg_in> <png_out> <width> <height>
//
// Setup:
//   cd web && npm i --no-save playwright && npx playwright install chromium
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const [svgPath, pngPath, wStr, hStr] = process.argv.slice(2);
if (!svgPath || !pngPath || !wStr || !hStr) {
  console.error('usage: render_og.mjs <svg_in> <png_out> <width> <height>');
  process.exit(1);
}
const W = Number(wStr);
const H = Number(hStr);

const svg = readFileSync(svgPath, 'utf8');
// Embed in a body that exactly matches the SVG box. No browser chrome,
// no scrollbars; just a transparent backdrop that the SVG fully covers.
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
svg{display:block;width:${W}px;height:${H}px}</style></head>
<body>${svg}</body></html>`;

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
});
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'load' });
const png = await page.screenshot({ omitBackground: false, type: 'png' });
writeFileSync(pngPath, png);
await browser.close();
console.log(`wrote ${pngPath} (${png.length} bytes)`);
