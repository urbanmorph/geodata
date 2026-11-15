// Render every favicon / app icon for bharatlas.com (web/public) and collect
// (collect/public) from the logo in shared/brand.mjs. Re-run after changing
// the mark:  node scripts/gen-icons.mjs   (from web/)
// Idempotent: a file is only rewritten when its bytes change.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { faviconSvg, collectFaviconSvg, PALETTE } from '../../shared/brand.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..');
await initWasm(readFileSync(resolve(here, '..', 'node_modules/@resvg/resvg-wasm/index_bg.wasm')));

const inner = (svg) => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');

// The mark on a white tile. `scale` keeps it inside the platform's safe zone
// (maskable icons are cropped to a circle of 80%).
function tile(svg, { scale, radius }) {
  const off = (40 - 40 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="${radius}" fill="${PALETTE.white}"/><g transform="translate(${off} ${off}) scale(${scale})">${inner(svg)}</g></svg>`;
}

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

// ICO holding PNG images (supported by every current browser).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((im) => Buffer.from(im.data))]);
}

function write(path, bytes) {
  const abs = resolve(ROOT, path);
  const buf = Buffer.from(bytes);
  if (existsSync(abs) && readFileSync(abs).equals(buf)) return console.log(`unchanged ${path}`);
  writeFileSync(abs, buf);
  console.log(`wrote     ${path} (${buf.length} bytes)`);
}

for (const [dir, svg, small] of [
  ['web/public', faviconSvg(), [16, 32]],
  ['collect/public', collectFaviconSvg(), [32]],
]) {
  write(`${dir}/favicon.svg`, svg + '\n');
  const smalls = [16, 32].map((size) => ({ size, data: png(svg, size) }));
  for (const s of smalls) if (small.includes(s.size)) write(`${dir}/favicon-${s.size}.png`, s.data);
  write(`${dir}/favicon.ico`, ico(smalls));
  write(`${dir}/apple-touch-icon.png`, png(tile(svg, { scale: 0.74, radius: 0 }), 180));
  write(`${dir}/icon-192.png`, png(tile(svg, { scale: 0.78, radius: 9 }), 192));
  write(`${dir}/icon-512.png`, png(tile(svg, { scale: 0.78, radius: 9 }), 512));
  write(`${dir}/icon-maskable-512.png`, png(tile(svg, { scale: 0.6, radius: 0 }), 512));
}
