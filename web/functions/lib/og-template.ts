// Pure SVG template for /og/view/<id>.png and /og/c/<id>.png. No resvg / no
// fetch so it stays unit-testable without WASM.

import { INDIA_PATH } from './og-india-path';

export type OgMetadata = {
  title: string;
  subtitle?: string;
  footerLeft?: string;
  footerRight?: string;
  tag?: string;
};

const W = 1200;
const H = 630;

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// resvg has no text overflow handling, so we hard-clip before rendering.
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

export function renderOgSvg(meta: OgMetadata): string {
  const title = clip(meta.title || 'bharatlas', 42);
  const subtitle = meta.subtitle ? clip(meta.subtitle, 60) : '';
  const footerL = meta.footerLeft ? clip(meta.footerLeft, 48) : 'open licences · attribution per card';
  const footerR = meta.footerRight ? clip(meta.footerRight, 32) : 'bharatlas.com';
  const tag = meta.tag ? clip(meta.tag, 18).toUpperCase() : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#312e81"/>
      <stop offset="100%" stop-color="#4338ca"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <g>
    <path d="${INDIA_PATH}" fill="#a5b4fc" fill-opacity="0.22" fill-rule="evenodd"
          stroke="#a5b4fc" stroke-opacity="0.5" stroke-width="1.5" stroke-linejoin="round"/>
  </g>
  <g font-family="ui-sans-serif, -apple-system, 'Segoe UI', system-ui, sans-serif">
    <text x="560" y="170" font-size="32" font-weight="500" fill="#f5f3ff" opacity="0.85">
      <tspan>bhar</tspan><tspan fill="#fbbf24">atlas</tspan>
    </text>
    <text x="560" y="260" font-size="62" font-weight="600" fill="#f5f3ff">${esc(title)}</text>
    ${subtitle ? `<text x="560" y="320" font-size="28" font-weight="400" fill="#c7d2fe">${esc(subtitle)}</text>` : ''}
    ${tag ? `<g>
      <rect x="${W - 220}" y="60" width="160" height="36" rx="18" fill="#f5f3ff" fill-opacity="0.12"/>
      <text x="${W - 140}" y="84" font-size="14" font-weight="600" fill="#f5f3ff" text-anchor="middle" letter-spacing="2">${esc(tag)}</text>
    </g>` : ''}
    <text x="60" y="${H - 50}" font-size="20" fill="#c7d2fe" opacity="0.85">${esc(footerL)}</text>
    <text x="${W - 60}" y="${H - 50}" font-size="20" fill="#c7d2fe" opacity="0.85" text-anchor="end">${esc(footerR)}</text>
  </g>
</svg>`;
}
