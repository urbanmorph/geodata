// bharatlas brand: India's colours as map layers.
// One source for the palette, the theme tokens, the logo mark and the
// wordmark. Plain ESM so prerender (node), Pages Functions, the web app and
// collect can all import it. Every surface that draws the brand reads from
// here; web/tests/brand.test.ts keeps the copies that cannot import it
// (favicon.svg) in sync.
import { escapeHtml as esc } from './format.mjs';

export const PALETTE = Object.freeze({
  saffron: '#F28C28', // actions: buttons, highlights. Carries navy text, never white.
  saffronHover: '#E8730C',
  saffronLight: '#F5A04A', // links + focus on dark backgrounds
  green: '#12804A', // India green: open, free, verified
  navy: '#0B1B3F', // chakra navy: ink, wordmark
  navyLink: '#1A2A6C', // links on light backgrounds
  white: '#FFFFFF',
});

// Semantic CSS custom properties, per colour scheme. Names match the tokens
// the pages already use (--accent for link text, --accent-fill for solid
// buttons) plus --on-accent-fill for the text on those buttons.
export const THEME = Object.freeze({
  light: Object.freeze({
    '--fg': PALETTE.navy,
    '--brand-ink': PALETTE.navy,
    '--accent': PALETTE.navyLink,
    '--accent-strong': PALETTE.navy,
    '--accent-fill': PALETTE.saffron,
    '--accent-fill-hover': PALETTE.saffronHover,
    '--on-accent-fill': PALETTE.navy,
    '--brand-green': PALETTE.green,
  }),
  dark: Object.freeze({
    '--fg': '#ededed',
    '--brand-ink': '#ededed',
    '--accent': PALETTE.saffronLight,
    '--accent-strong': PALETTE.saffron,
    '--accent-fill': PALETTE.saffron,
    '--accent-fill-hover': PALETTE.saffronLight,
    '--on-accent-fill': PALETTE.navy,
    '--brand-green': '#1FA463',
  }),
});

/** CSS declarations for one scheme, e.g. "--fg: #0B1B3F; --accent: ...;" */
export function themeDecls(mode) {
  return Object.entries(THEME[mode]).map(([k, v]) => `${k}: ${v};`).join(' ');
}

// The mark: three stacked map layers, saffron over white over green.
// The white layer keeps a navy outline so it reads on white and dark grounds.
function markPaths(stroke) {
  return `<path d="M20 22 L36 30 L20 38 L4 30 Z" fill="${PALETTE.green}"/><path d="M20 14 L36 22 L20 30 L4 22 Z" fill="${PALETTE.white}" stroke="${PALETTE.navy}" stroke-width="${stroke}" stroke-linejoin="round"/><path d="M20 4 L36 12 L20 20 L4 12 Z" fill="${PALETTE.saffron}"/>`;
}

/** Inline, decorative logo mark (the visible name labels the link). */
export function brandMarkSvg(size = 24) {
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true" focusable="false">${markPaths(1.6)}</svg>`;
}

/** Standalone favicon / app-icon source. A heavier outline reads at 16 px. */
export function faviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${markPaths(2.4)}</svg>`;
}

// collect's icon: the same mark with a navy map-pin badge (collect is where you
// drop points), so the two installed apps tell apart on a home screen.
const PIN_BADGE = `<g class="pin"><circle cx="31" cy="31" r="9" fill="${PALETTE.white}"/><circle cx="31" cy="31" r="7.5" fill="${PALETTE.navy}"/><path d="M31 36.5 C29.6 34.4 27.2 32.3 27.2 29.6 A3.8 3.8 0 1 1 34.8 29.6 C34.8 32.3 32.4 34.4 31 36.5 Z M31 28.2 A1.4 1.4 0 1 0 31.01 28.2 Z" fill="${PALETTE.white}" fill-rule="evenodd"/></g>`;

/** collect's favicon / app-icon source. */
export function collectFaviconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${markPaths(2.4)}${PIN_BADGE}</svg>`;
}


/** The logo link: mark + "bharatlas" in one ink colour + optional tagline. */
export function wordmarkHtml({ href = '/', tagline = '', className = 'site-brand', size = 24 } = {}) {
  const tag = tagline ? `<span class="tagline">${esc(tagline)}</span>` : '';
  return `<a class="${className}" href="${esc(href)}">${brandMarkSvg(size)}<span class="brand-name">bharatlas</span>${tag}</a>`;
}

/** Layout CSS for the wordmark; colours come from the theme tokens. */
export const WORDMARK_CSS = `.site-brand { display: inline-flex; align-items: center; gap: 8px; color: var(--brand-ink); text-decoration: none; font-weight: 800; letter-spacing: -.025em; }
  .site-brand:hover { text-decoration: none; }
  .site-brand .brand-mark { flex: none; }`;
