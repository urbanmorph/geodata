// The design tokens: every colour role, type step, weight, line height, space,
// radius, border, shadow, layer, duration, breakpoint and icon size, light and
// dark, in one place. bharatlas.com (web/scripts/shared-chrome.mjs) and collect
// (collect/vite.config.ts) both emit their :root from tokensCss(), so the two
// sites share token names and values, and /design (web/scripts/design-page.mjs)
// shows the real values. Brand colours come from shared/brand.mjs.
//
// Changing a token: edit it here, add a DESIGN_CHANGELOG entry, bump
// DESIGN_VERSION. A renamed token keeps a deprecated alias for one release.
import { PALETTE, THEME } from './brand.mjs';

export const DESIGN_VERSION = '1.1.0';

/** Newest first. Each entry: version, ISO date, what changed. */
export const DESIGN_CHANGELOG = Object.freeze([
  {
    version: '1.1.0',
    date: '2026-11-22',
    changes: [
      'Spacing, borders, shadows, layers and motion on both sites now come from the tokens; the build fails on a new hard-coded value of those kinds.',
      'Spacing gains 2 px half steps (--sp-0-5, --sp-1-5, --sp-2-5, --sp-3-5, --sp-4-5): 2, 6, 10, 14 and 18 px recur in controls and lists.',
      'New borders: --border-strong (the search field), --border-bright, --border-dashed and --border-focus (the focus ring). New shadow: --shadow-halo (the saffron glow round a focused search).',
      'Transitions of 140 to 150 ms now use --dur-fast (120 ms), and 180 to 220 ms use --dur-base (200 ms).',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-11-21',
    changes: [
      'One token module for bharatlas.com and collect: the same names and values on both sites.',
      'Status colours deepened in light mode so they pass AA as text on every surface.',
      'India green as text deepened a shade (#0F7A45) to pass AA on the hover tints.',
      'New scales: font families, weights, line heights, borders, z-index layers, motion, icon sizes.',
      'collect names follow bharatlas.com: --card and --sheet are --bg-elevated, --surface is --bg-card, --accent-solid is --accent-fill, its old tint is --accent-tint.',
      'theme-color and the app manifests match the paper (--bg).',
      'Deprecated: --radius (use --radius-sm).',
    ],
  },
]);

// Colour roles. kind says how a role may be used, and what the contrast test
// checks it against: text (4.5:1 on every surface), surface, edge (3:1 on every
// surface), fill (an action fill; its text role must pass on it), decor (no
// contrast duty: grid lines, hairlines).
const brand = (k) => ({ light: THEME.light[k], dark: THEME.dark[k] });
export const COLOR_ROLES = Object.freeze([
  { name: '--bg', kind: 'surface', light: '#F3F6F1', dark: '#0a0a0a', use: 'Paper behind the page.' },
  { name: '--bg-elevated', kind: 'surface', light: '#ffffff', dark: '#15151a', use: 'Panels, sheets, cards and the header on the paper.' },
  { name: '--bg-card', kind: 'surface', light: '#E9EFEA', dark: '#1a1a1f', use: 'Hover and selected tint; raised sections.' },
  { name: '--land', kind: 'surface', light: '#E6F2EA', dark: '#13261C', use: 'Land fill; the hover of a line button.' },
  { name: '--accent-tint', kind: 'surface', light: '#FFF1E3', dark: '#3A2410', use: 'A pale saffron behind a selected choice.' },
  { name: '--fg', kind: 'text', ...brand('--fg'), use: 'Body text and headings (chakra navy).' },
  { name: '--brand-ink', kind: 'text', ...brand('--brand-ink'), use: 'The wordmark.' },
  { name: '--muted', kind: 'text', light: '#4B5563', dark: '#9ca3af', use: 'Secondary text: notes, counts, captions.' },
  { name: '--muted-strong', kind: 'text', light: '#374151', dark: '#d4d4d8', use: 'Secondary text that needs more weight.' },
  { name: '--accent', kind: 'text', ...brand('--accent'), use: 'Links.' },
  { name: '--accent-strong', kind: 'text', ...brand('--accent-strong'), use: 'The focus ring; strong accents.' },
  { name: '--brand-green', kind: 'text', ...brand('--brand-green'), use: 'India green: open, free, verified; map-sheet labels.' },
  { name: '--ok', kind: 'text', light: '#157236', dark: '#4ade80', use: 'Success.' },
  { name: '--warn', kind: 'text', light: '#a14a0b', dark: '#fbbf24', use: 'Warning: large files, pending review.' },
  { name: '--err', kind: 'text', light: '#b91c1c', dark: '#f87171', use: 'Errors; the non-commercial label tint.' },
  { name: '--accent-fill', kind: 'fill', ...brand('--accent-fill'), use: 'Saffron: the primary action. Always navy text, never white.' },
  { name: '--accent-fill-hover', kind: 'fill', ...brand('--accent-fill-hover'), use: 'The primary action on hover.' },
  { name: '--on-accent-fill', kind: 'on-fill', ...brand('--on-accent-fill'), use: 'Text on saffron.' },
  { name: '--edge', kind: 'edge', light: PALETTE.navy, dark: '#C8D0E3', use: 'The survey-sheet edge on controls, cards and the header.' },
  { name: '--line', kind: 'decor', light: '#D5DED7', dark: '#262626', use: 'Hairline between rows. Never the only edge of a control.' },
  { name: '--line-bright', kind: 'decor', light: '#B8C4BC', dark: '#404040', use: 'A stronger hairline. Never the only edge of a control.' },
  { name: '--grid', kind: 'decor', light: 'rgba(18, 128, 74, .07)', dark: 'rgba(63, 203, 126, .06)', use: 'Grid paper lines.' },
]);

const decl = (pairs) => Object.freeze(Object.fromEntries(pairs));

// Scale tokens: the same in both themes.
export const FONT = decl([
  ['--font-sans', 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Inter", sans-serif'],
  ['--font-mono', 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace'],
]);
export const FONT_SIZE = decl([
  ['--fs-xs', '12px'], ['--fs-sm', '13px'], ['--fs-base', '15px'], ['--fs-md', '16px'], ['--fs-lg', '18px'],
  ['--fs-xl', '22px'], ['--fs-2xl', '24px'], ['--fs-3xl', '32px'], ['--fs-4xl', '44px'], ['--fs-display', '72px'],
]);
export const FONT_WEIGHT = decl([
  ['--fw-regular', '400'], ['--fw-medium', '600'], ['--fw-bold', '750'], ['--fw-heavy', '850'],
]);
export const LINE_HEIGHT = decl([
  ['--lh-tight', '1.15'], ['--lh-snug', '1.35'], ['--lh-base', '1.55'], ['--lh-loose', '1.65'],
]);
// A 4 px grid, with the 2 px half steps (--sp-N-5) that controls and lists repeat.
export const SPACE = decl([
  ['--sp-0-5', '2px'], ['--sp-1', '4px'], ['--sp-1-5', '6px'], ['--sp-2', '8px'], ['--sp-2-5', '10px'],
  ['--sp-3', '12px'], ['--sp-3-5', '14px'], ['--sp-4', '16px'], ['--sp-4-5', '18px'],
  ['--sp-5', '20px'], ['--sp-6', '24px'], ['--sp-7', '32px'], ['--sp-8', '48px'],
]);
export const RADIUS = decl([
  ['--radius-sm', '4px'], ['--radius-md', '6px'], ['--radius-lg', '8px'], ['--radius-xl', '12px'], ['--radius-pill', '999px'],
]);
/** Renamed tokens, kept for one release: name → the token it points at. */
export const DEPRECATED = decl([['--radius', 'var(--radius-sm)']]);
export const BORDER = decl([
  ['--border-edge', '1.5px solid var(--edge)'], ['--border-strong', '2px solid var(--edge)'],
  ['--border-line', '1px solid var(--line)'], ['--border-bright', '1px solid var(--line-bright)'],
  ['--border-dashed', '1px dashed var(--line)'], ['--border-focus', '2px solid var(--accent-strong)'],
]);
// Hard offset shadows only: no blur. The sheet shadow is a navy top edge.
export const SHADOW = decl([
  ['--shadow-sm', '3px 3px 0 var(--edge)'], ['--shadow', '4px 4px 0 var(--edge)'], ['--shadow-sheet', '0 -1.5px 0 var(--edge)'],
  ['--shadow-halo', '0 0 0 4px color-mix(in srgb, var(--accent-fill) 35%, transparent)'],
]);
// Named stacking layers, lowest first.
export const Z = decl([
  ['--z-raised', '1'], ['--z-map-ui', '5'], ['--z-sticky', '10'], ['--z-sheet', '16'],
  ['--z-popover', '20'], ['--z-dialog', '50'], ['--z-skip', '1000'],
]);
export const MOTION = decl([
  ['--dur-fast', '120ms'], ['--dur-base', '200ms'], ['--dur-slow', '320ms'],
  ['--ease', 'cubic-bezier(.2, .7, .3, 1)'],
]);
export const ICON = decl([['--icon-sm', '16px'], ['--icon-md', '20px'], ['--icon-lg', '24px']]);
/** The smallest touch target. */
export const TAP = decl([['--tap', '44px']]);

export const LAYOUT = decl([['--page-max', '1120px']]);

/** Media-query widths (CSS cannot read custom properties in @media, so these stay numbers). */
export const BREAKPOINTS = Object.freeze({ sm: 640, md: 900, lg: 1100 });

export const SCALES = Object.freeze({ FONT, FONT_SIZE, FONT_WEIGHT, LINE_HEIGHT, SPACE, RADIUS, BORDER, SHADOW, Z, MOTION, ICON, TAP, LAYOUT, DEPRECATED });

/** { light: {'--bg': '#...', ...}, dark: {...} } */
export const COLORS = Object.freeze({
  light: decl(COLOR_ROLES.map((r) => [r.name, r.light])),
  dark: decl(COLOR_ROLES.map((r) => [r.name, r.dark])),
});

// The dark block repeats only what differs from light (saffron is the same in both).
const DARK_ONLY = decl(Object.entries(COLORS.dark).filter(([k, v]) => COLORS.light[k] !== v));
const lines = (o) => Object.entries(o).map(([k, v]) => `${k}: ${v};`).join(' ');

/** The :root token CSS: scales and light colours, then the dark colours. */
export function tokensCss() {
  const scales = Object.values(SCALES).map(lines).join('\n    ');
  return `:root {
    ${scales}
    ${lines(COLORS.light)}
  }
  @media (prefers-color-scheme: dark) {
    :root { ${lines(DARK_ONLY)} }
  }`;
}

/** Where collect's stylesheet takes the token CSS (collect/vite.config.ts fills it). */
export const TOKENS_MARKER = '/* @design-tokens */';

/** A stylesheet with its marker replaced by the token CSS. */
export function injectTokens(css) {
  return css.replace(TOKENS_MARKER, () => tokensCss());
}

// WCAG 2.x relative luminance and contrast, for #rrggbb colours.
function luminance(hex) {
  const n = hex.replace('#', '');
  const ch = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(ch[0]) + 0.7152 * lin(ch[1]) + 0.0722 * lin(ch[2]);
}
/** Contrast ratio of two #rrggbb colours (1 to 21). */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
