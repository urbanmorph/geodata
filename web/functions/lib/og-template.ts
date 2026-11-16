// Pure SVG template for /og/view/<id>.png and /og/c/<id>.png. No resvg / no
// fetch so it stays unit-testable without WASM.

import { INDIA_PATH } from './og-india-path';
import { PALETTE } from '../../../shared/brand.mjs';
import { escapeHtml as esc } from '../../../shared/format.mjs';
import widths from './og-widths.json';

export type OgMetadata = {
  title: string;
  subtitle?: string;
  footerLeft?: string;
  footerRight?: string;
  tag?: string;
};

// Static instances of DM Sans (scripts/gen_og_fonts.py): resvg can't apply a
// variable font's weight axis, so each weight the cards use is its own file.
export const OG_FONT_FILES = ['og-font-400.ttf', 'og-font-600.ttf', 'og-font-800.ttf'];

const W = 1200;
const H = 630;
const FONT = `font-family="DM Sans, ui-sans-serif, system-ui, sans-serif"`;

// resvg has no text layout, so titles are measured here: advance widths of DM
// Sans SemiBold (scripts/gen_og_fonts.py), unknown characters at a wide 0.62em.
const EM: Record<string, number> = widths.em;
export const TITLE_MAX_W = 580; // the right-hand column: x 560 to 1140

export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += EM[ch] ?? 0.62;
  return w * size;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

// Trim a line from the end until it and an ellipsis fit.
function clipToWidth(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s;
  let t = s;
  while (t.length > 1 && textWidth(t + '…', size) > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

function wrap(text: string, size: number, maxW: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size) > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** Largest size at which text wraps into maxLines that all fit; else the smallest size, clipped. */
export function fitLines(text: string, sizes: number[], maxW: number, maxLines: number): { size: number; lines: string[] } {
  for (const size of sizes) {
    const lines = wrap(text, size, maxW);
    if (lines.length <= maxLines && lines.every((l) => textWidth(l, size) <= maxW)) return { size, lines };
  }
  const size = sizes[sizes.length - 1];
  const all = wrap(text, size, maxW);
  const lines = all.slice(0, maxLines);
  if (all.length > maxLines) lines[maxLines - 1] += ' ' + all.slice(maxLines).join(' ');
  return { size, lines: lines.map((l) => clipToWidth(l, size, maxW)) };
}

const BACKGROUND = `<defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${PALETTE.navy}"/>
      <stop offset="100%" stop-color="#13265A"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g>
    <path d="${INDIA_PATH}" fill="#FFFFFF" fill-opacity="0.06" fill-rule="evenodd"
          stroke="${PALETTE.saffron}" stroke-opacity="0.85" stroke-width="2" stroke-linejoin="round"/>
  </g>`;

// The three-layer mark (shared/brand.mjs) in the card's 40-unit box.
const mark = (x: number, y: number, scale = 1) => `<g transform="translate(${x},${y}) scale(${scale})">
    <path d="M20 22 L36 30 L20 38 L4 30 Z" fill="${PALETTE.green}"/>
    <path d="M20 14 L36 22 L20 30 L4 22 Z" fill="#FFFFFF" stroke="${PALETTE.navy}" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M20 4 L36 12 L20 20 L4 12 Z" fill="${PALETTE.saffron}"/>
  </g>`;

const svgDoc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${BACKGROUND}
  ${body}
</svg>`;

/** Per-layer card: /og/view/<id>.png and /og/c/<id>.png. */
export function renderOgSvg(meta: OgMetadata): string {
  const { size, lines } = fitLines(meta.title || 'bharatlas', [62, 54, 46], TITLE_MAX_W, 2);
  const subtitle = meta.subtitle ? clipToWidth(meta.subtitle, 28, TITLE_MAX_W) : '';
  const footerL = meta.footerLeft ? clip(meta.footerLeft, 48) : 'open licences · attribution per card';
  const footerR = meta.footerRight ? clip(meta.footerRight, 32) : 'bharatlas.com';
  const tag = meta.tag ? clip(meta.tag, 18).toUpperCase() : '';
  const lead = Math.round(size * 1.12);
  const top = lines.length > 1 ? 250 : 260;
  const titles = lines
    .map((l, i) => `<text class="title" x="560" y="${top + i * lead}" font-size="${size}" font-weight="600" fill="#FFFFFF">${esc(l)}</text>`)
    .join('\n    ');
  const subY = top + (lines.length - 1) * lead + 60;

  return svgDoc(`${mark(560, 136)}
  <g ${FONT}>
    <text x="610" y="170" font-size="34" font-weight="800" letter-spacing="-0.5" fill="#FFFFFF">bharatlas</text>
    ${titles}
    ${subtitle ? `<text class="subtitle" x="560" y="${subY}" font-size="28" font-weight="400" fill="#C8D0E3">${esc(subtitle)}</text>` : ''}
    ${tag ? `<g>
      <rect x="${W - 220}" y="60" width="160" height="36" rx="18" fill="#FFFFFF" fill-opacity="0.12"/>
      <text x="${W - 140}" y="84" font-size="14" font-weight="600" fill="#FFFFFF" text-anchor="middle" letter-spacing="2">${esc(tag)}</text>
    </g>` : ''}
    <text x="60" y="${H - 50}" font-size="20" fill="#C8D0E3" opacity="0.85">${esc(footerL)}</text>
    <text x="${W - 60}" y="${H - 50}" font-size="20" fill="#C8D0E3" opacity="0.85" text-anchor="end">${esc(footerR)}</text>
  </g>`);
}

export type OgHero = { tagline: string; sub?: string; footer?: [string, string] };

/** Site-wide share image (og-default / og-preview / og-about): big wordmark + tagline. */
export function renderOgHeroSvg(h: OgHero): string {
  const X = 600;
  const maxW = W - X - 50;
  // A "\n" in the tagline sets the break; otherwise it wraps by width.
  const forced = h.tagline.split('\n');
  const { size, lines } =
    forced.length > 1
      ? { size: [36, 32, 28].find((z) => forced.every((l) => textWidth(l, z) <= maxW)) ?? 28, lines: forced }
      : fitLines(h.tagline, [36, 32, 28], maxW, 2);
  const lead = Math.round(size * 1.2);
  const tag = lines
    .map((l, i) => `<text class="tagline" x="${X}" y="${360 + i * lead}" font-size="${size}" font-weight="600" fill="#FFFFFF">${esc(l)}</text>`)
    .join('\n    ');
  const subY = 360 + (lines.length - 1) * lead + 46;
  return svgDoc(`${mark(X, 96, 2)}
  <g ${FONT}>
    <text x="${X - 4}" y="300" font-size="118" font-weight="800" letter-spacing="-3" fill="#FFFFFF">bharatlas</text>
    ${tag}
    ${h.sub ? `<text x="${X}" y="${subY}" font-size="24" font-weight="400" fill="#C8D0E3">${esc(clipToWidth(h.sub, 24, maxW))}</text>` : ''}
    ${h.footer ? `<text x="${X}" y="530" font-size="20" font-weight="400" fill="#C8D0E3" opacity="0.8">${esc(h.footer[0])}</text>
    <text x="${X}" y="560" font-size="20" font-weight="400" fill="#C8D0E3" opacity="0.8">${esc(h.footer[1])}</text>` : ''}
  </g>`);
}
