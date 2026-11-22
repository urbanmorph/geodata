// /design: the living style guide. Its body is built here, at prerender time,
// from shared/tokens.mjs (and the brand, licence and map modules), so every
// value it shows is the value bharatlas.com and collect use. design.template.html
// holds the page and its demo styles; web/tests/design-page.test.ts checks it.
import {
  COLOR_ROLES, COLORS, FONT, FONT_SIZE, FONT_WEIGHT, LINE_HEIGHT, SPACE, RADIUS, BORDER, SHADOW, Z, MOTION,
  ICON, BREAKPOINTS, DESIGN_VERSION, DESIGN_CHANGELOG, contrast,
} from '../../shared/tokens.mjs';
import { brandMarkSvg, wordmarkHtml, PALETTE } from '../../shared/brand.mjs';
import { licenceBadgeHtml, NC_LABEL } from '../../shared/licences.mjs';
import { CHOROPLETH_RAMP, NO_DATA_HATCH } from '../../shared/choropleth.mjs';
import { escapeHtml as esc, fmtInt } from '../../shared/format.mjs';

const code = (s) => `<code>${esc(s)}</code>`;
const ratio = (a, b) => `${contrast(a, b).toFixed(1)}:1`;
const SURFACES = COLOR_ROLES.filter((r) => r.kind === 'surface').map((r) => r.name);
const section = (id, title, body) => `<section id="${id}" aria-labelledby="${id}-h"><h2 id="${id}-h">${title}</h2><div class="sec">${body}</div></section>`;
const table = (head, rows, cls = '') =>
  `<div class="table-wrap${cls ? ` ${cls}` : ''}"><table><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const list = (items, cls = '') => `<ul${cls ? ` class="${cls}"` : ''}>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

// What a role's contrast means: text on the paper (and its lowest on any
// surface), the ink on a surface, the edge on the paper, ink on a fill.
function contrastNote(role, mode) {
  const c = COLORS[mode];
  const v = c[role.name];
  if (!v.startsWith('#')) return 'decoration';
  switch (role.kind) {
    case 'text': {
      const low = Math.min(...SURFACES.map((s) => contrast(v, c[s])));
      return `${ratio(v, c['--bg'])} on paper, ${low.toFixed(1)}:1 lowest`;
    }
    case 'surface': return `ink ${ratio(c['--fg'], v)}`;
    case 'fill': return `text ${ratio(c['--on-accent-fill'], v)}`;
    case 'on-fill': return `${ratio(v, c['--accent-fill'])} on saffron`;
    case 'edge': return `${ratio(v, c['--bg'])} on paper`;
    default: return `${ratio(v, c['--bg'])}: never the only edge`;
  }
}
const swatchCell = (role, mode) =>
  `<span class="sw" style="background:${esc(role[mode])}"></span>${code(role[mode])}<br><span class="ratio">${contrastNote(role, mode)}</span>`;

function colours() {
  const rows = COLOR_ROLES.map((r) => [`${code(r.name)}<br><span class="kind">${r.kind}</span>`, swatchCell(r, 'light'), swatchCell(r, 'dark'), esc(r.use)]);
  return `<p>Colours are roles, not hex values: use the role, and both themes follow. Saffron is for actions and always carries navy text. India green marks what is open, free or verified. Chakra navy is the ink and the edge.</p>
<p>Every text role reads at 4.5:1 or more on every surface, in both themes, and edges and the focus ring at 3:1 or more (tested). Hairlines (${code('--line')}, ${code('--line-bright')}) are decoration and never the only edge of a control.</p>
${table(['Role', 'Light', 'Dark', 'Use'], rows, 'wide swatch-table')}`;
}

const specimen = 'India’s open atlas';
function type() {
  const sizes = Object.entries(FONT_SIZE).map(([k, v]) => `<li><span class="spec-k">${code(k)} ${v}</span><span class="spec" style="font-size:var(${k})">${specimen}</span></li>`);
  const weights = Object.entries(FONT_WEIGHT).map(([k, v]) => `<li><span class="spec-k">${code(k)} ${v}</span><span class="spec" style="font-weight:var(${k})">${specimen}</span></li>`);
  return `<p>System fonts only: nothing to download, and each phone reads in its own face. Labels on the map sheet use the monospace.</p>
${table(['Token', 'Value'], Object.entries(FONT).map(([k, v]) => [code(k), `<span style="font-family:var(${k})">${esc(v)}</span>`]))}
<h3>Sizes</h3><p>Ten steps; every font size on both sites is one of them (tested).</p><ul class="specs wide">${sizes.join('')}</ul>
<h3>Weights</h3><ul class="specs">${weights.join('')}</ul>
<h3>Line heights</h3>${table(['Token', 'Value', 'Use'], [
    [code('--lh-tight'), LINE_HEIGHT['--lh-tight'], 'Page and section titles'],
    [code('--lh-snug'), LINE_HEIGHT['--lh-snug'], 'Labels and short lines'],
    [code('--lh-base'), LINE_HEIGHT['--lh-base'], 'Body text'],
    [code('--lh-loose'), LINE_HEIGHT['--lh-loose'], 'Code and dense tables'],
  ])}`;
}

function space() {
  const bars = Object.entries(SPACE).map(([k, v]) => `<li><span class="spec-k">${code(k)} ${v}</span><span class="bar" style="width:var(${k})"></span></li>`);
  return `<p>A 4 px grid, with 2 px half steps (${code('--sp-N-5')}) for controls and lists. Gaps, padding and margins take a step from this scale (tested).</p><ul class="specs">${bars.join('')}</ul>`;
}

function shape() {
  const radii = Object.entries(RADIUS).map(([k, v]) => `<li><span class="corner" style="border-radius:var(${k})"></span>${code(k)} ${v}</li>`);
  const shadows = Object.entries(SHADOW).map(([k, v]) => `<li><span class="lift" style="box-shadow:var(${k})"></span>${code(k)}<br><span class="ratio">${esc(v)}</span></li>`);
  const borders = Object.entries(BORDER).map(([k, v]) => [code(k), code(v)]);
  return `<p>Buttons and fields have 4 px corners (${code('--radius-sm')}). Cards, sheets and panels take a step from the scale. Chips and filters are pills. A dot can be round (50%). No other corner values (tested).</p>
<ul class="tiles">${radii.join('')}</ul>
<h3>Borders</h3><p>The navy edge outlines controls, cards and the header; a hairline only separates rows.</p>${table(['Token', 'Value'], borders)}
<h3>Elevation</h3><p>Hard offset shadows only, no blur: the sheet lifts off the paper like a printed map. The primary action casts one and presses into it.</p><ul class="tiles">${shadows.join('')}</ul>`;
}

const Z_USE = {
  '--z-raised': 'A card over its neighbour', '--z-map-ui': 'Controls over the map', '--z-sticky': 'Sticky bars',
  '--z-sheet': 'Bottom sheets and panels', '--z-popover': 'Popovers and toasts', '--z-dialog': 'Dialogs and viewers', '--z-skip': 'The skip link',
};
function system() {
  return `<h3>Layers</h3><p>Named stacking layers, lowest first. Use the name, not a number; a layer just above or below one is ${code('calc(var(--z-map-ui) + 1)')} (tested).</p>
${table(['Token', 'Value', 'Use'], Object.entries(Z).map(([k, v]) => [code(k), v, Z_USE[k] ?? '']))}
<h3>Motion</h3><p>Short and functional: a sheet slides, a button presses. With reduced motion on, nothing slides, pings or spins, and the map on bharatlas.com jumps instead of flying (tested).</p>
${table(['Token', 'Value'], Object.entries(MOTION).map(([k, v]) => [code(k), code(v)]))}
<h3>Breakpoints</h3><p>Three widths. CSS cannot read a custom property in a media query, so these live in the token module as numbers.</p>
${table(['Name', 'Width', 'What changes'], [
    ['sm', `${BREAKPOINTS.sm} px`, 'Phones: the nav folds into a menu, the map toolbar moves to the bottom'],
    ['md', `${BREAKPOINTS.md} px`, 'Tablets: the tagline goes, the theme index becomes a row of chips'],
    ['lg', `${BREAKPOINTS.lg} px`, 'Wide screens: the page column stops growing'],
  ])}
<h3>Icons</h3><p>Line icons in ${code('currentColor')}, at one of three sizes.</p>
<ul class="tiles">${Object.entries(ICON).map(([k, v]) => `<li>${searchIcon(`var(${k})`)}${code(k)} ${v}</li>`).join('')}</ul>`;
}

const searchIcon = (size) => `<svg viewBox="0 0 24 24" style="width:${size};height:${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

const STATES = [['', 'Default'], ['is-hover', 'Hover'], ['is-focus', 'Focus'], ['is-active', 'Pressed'], ['', 'Disabled']];
const stateRow = (label, cls, text) =>
  `<tr><th scope="row">${label}</th>${STATES.map(([s, name]) => `<td><button type="button" class="${cls}${s ? ` ${s}` : ''}"${name === 'Disabled' ? ' disabled' : ''}>${text}</button></td>`).join('')}</tr>`;

function buttons() {
  return `<ul>
<li><strong>Primary</strong> (${code('.btn .btn--fill')}): saffron with navy text, the navy edge and a hard offset shadow; it presses into the shadow. One primary action per area: the hero, a panel, a dialog.</li>
<li><strong>Secondary</strong> (${code('.btn .btn--line')}): white with the navy edge; land green on hover. Everything else that is a button.</li>
<li><strong>Map toolbar</strong> (${code('.tbtn')}): its own spec, compact and in a row over the map. On phones it stacks the icon over the label.</li>
<li>Buttons have 4 px corners and a ${FONT_WEIGHT['--fw-bold']} weight label in sentence case that says what happens: “View map”, not “Click here”.</li>
<li>Chips and filters are pills and are not buttons: they choose, they do not act.</li>
<li>Every target is at least 44 px tall on touch screens.</li>
</ul>
<div class="table-wrap wide"><table class="states"><thead><tr><th scope="col">Kind</th>${STATES.map(([, n]) => `<th scope="col">${n}</th>`).join('')}</tr></thead><tbody>
${stateRow('Primary', 'btn btn--fill', 'View map')}
${stateRow('Secondary', 'btn btn--line', 'Download')}
${stateRow('Toolbar', 'tbtn', 'Filter')}
</tbody></table></div>`;
}

function parts() {
  return `<h3>Chips</h3><p>Pills with the navy edge; the chosen one takes the saffron tint.</p>
<div class="demo" role="group" aria-label="Example chips"><button type="button" class="chip" aria-pressed="true">Water</button><button type="button" class="chip" aria-pressed="false">Boundaries</button><button type="button" class="chip" aria-pressed="false">Health</button></div>
<h3>Badges</h3><p>Small monospace labels. Every layer shows its licence; a non-commercial layer also says “${NC_LABEL}” in a red tint, wherever it is listed.</p>
<div class="demo">${licenceBadgeHtml('CC-BY-4.0')} ${licenceBadgeHtml('CC-BY-NC-4.0', true)} <span class="badge badge--stable">Stable</span> <span class="badge badge--soon">Soon</span></div>
<h3>Search</h3><p>One field with the search icon, the navy edge and the offset shadow; the ring shows on focus.</p>
<div class="demo-search">${searchIcon('var(--icon-md)')}<input type="search" class="catalog-search" placeholder="Search a ward, place or map" aria-label="Search (example)"></div>
<h3>Fields</h3><p>A visible label above, 44 px tall, the navy edge. An error turns the edge red and says how to fix it, under the field.</p>
<div class="fields wide">
<div><label for="d-name">Map name</label><input id="d-name" class="field" value="Ward 112 trees"></div>
<div><label for="d-year">Data year</label><input id="d-year" class="field" value="20256" aria-invalid="true" aria-describedby="d-year-err"><p id="d-year-err" class="field-err">Enter a year, like 2025.</p></div>
<div><label for="d-src">Source</label><input id="d-src" class="field" value="Your own survey" disabled></div>
</div>`;
}

function access() {
  return list([
    'Targets: at least 44 by 44 px on touch screens.',
    `Focus: a 2 px ${code('--accent-strong')} outline, 2 px out, on every focusable thing. Never removed, only restyled.`,
    'The current page in the nav carries <code>aria-current="page"</code>; its style keys on that, so what you see is what a screen reader hears.',
    'Reduced motion: no slides, pings or spins; spinners stand still; the map jumps.',
    'Forced colours (Windows contrast themes): the primary action becomes Highlight, the current page is underlined, focus keeps its outline.',
    'Colour never carries meaning alone: a status also has a word or a symbol, a link in text is underlined.',
    'Light and dark follow the device. At 390 px wide no page scrolls sideways.',
  ]);
}

function content() {
  return list([
    'Say <strong>layer</strong> and <strong>theme</strong>. “Category” belongs to the API and the code; the internal word for the full list never shows.',
    'Sentence case for every label, heading and button. Nothing set in capitals.',
    'No em-dashes: use a comma, colon, full stop or brackets.',
    `Numbers in the Indian way, en-IN: ${fmtInt(584615)}, ${fmtInt(29409120)}. Large counts may read 39.5k in tight spaces.`,
    'Dates read 21 Nov 2026; the machine form (2026-11-21) goes in the <code>datetime</code> attribute. The “Updated” line on layer rows still shows the machine form (planned).',
    'An empty value reads “n/a”.',
    `Credit the source and show the licence on every layer; a non-commercial layer says “${NC_LABEL}” on its card, in the API and in the MCP.`,
  ]);
}

function logo() {
  const sizes = [16, 24, 32, 48].map((s) => `<li>${brandMarkSvg(s)}${s} px</li>`);
  return `<p>Three stacked map layers, saffron over white over green, with the name in one ink. The mark and the name always go together in the header (the lockup); the mark alone is for icons and the map toolbar.</p>
<div class="demo demo--logo">${wordmarkHtml({ href: '/', tagline: 'India’s open atlas' })}</div>
${list([
    'Clear space: half the mark’s height on every side.',
    'Smallest: 16 px for the mark (the favicon draws a heavier outline), 24 px in the header lockup.',
    `Never recolour the layers: saffron ${code(PALETTE.saffron)}, white, India green ${code(PALETTE.green)}, outlined in navy ${code(PALETTE.navy)}.`,
    'collect adds a navy map pin to the mark, so the two apps tell apart on a home screen.',
  ])}<ul class="tiles">${sizes.join('')}</ul>`;
}

function maps() {
  const ramp = CHOROPLETH_RAMP.map((c) => `<li><span class="sw sw--lg" style="background:${c}"></span>${code(c)}</li>`);
  return `<p>Numbers on a map use one hue, light to dark green, up to five steps, safe for colour-blind readers. Places with no value are not filled; they are hatched in navy, so “no data” never reads as “low”.</p>
<ul class="tiles">${ramp.join('')}<li><svg class="sw sw--lg" viewBox="0 0 8 8" aria-hidden="true"><defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 4 4 0" stroke="${NO_DATA_HATCH}" stroke-width="1"/></pattern></defs><rect width="8" height="8" fill="url(#hatch)"/></svg>No data</li></ul>
<p>Layer lines and fills keep the theme’s colour; the map’s own controls take the panel tokens in dark mode.</p>`;
}

const TESTS = [
  ['design-tokens', 'Both sites emit the token module, with no token of their own; theme-color is the paper'],
  ['contrast', 'Every text role on every surface, text on saffron, edges and focus, both themes'],
  ['type-scale', 'Every font size is a scale step'],
  ['design-lints', 'Corners, spacing, borders, shadows, layers and motion from the tokens; fonts from the two families; button classes, forced colours, en-IN numbers, transitions that name what they animate'],
  ['survey-sheet, page-system', 'The navy edge, offset shadow and grid paper; one page system'],
  ['no-emdash, terminology, design-audit', 'No em-dashes, the site’s words, sentence case, 44 px targets'],
  ['reduced-motion', 'Nothing moves when reduced motion is on'],
  ['design-page', 'This page shows the real tokens'],
];
function governance() {
  const log = DESIGN_CHANGELOG.map((e) => `<li><strong>${esc(e.version)}</strong> (${esc(e.date)})${list(e.changes.map(esc))}</li>`).join('');
  return `<p>Design version <strong>${DESIGN_VERSION}</strong>. Every token lives in one module, ${code('shared/tokens.mjs')}, with the brand in ${code('shared/brand.mjs')}. bharatlas.com and collect both build their tokens from it, and this page is built from it, so none of them can drift.</p>
<p>To change a token: edit the module, add a changelog entry and raise the version. A renamed token keeps its old name as an alias for one release. The tests below fail when a page breaks a rule.</p>
${table(['Test', 'What it holds'], TESTS.map(([t, w]) => [code(t), w]))}
<h3>Changelog</h3><ul class="log">${log}</ul>`;
}

function planned() {
  return list([
    'One shared component each for search, chips, sheets, popups, spinners, status messages, empty states and form states.',
    'The map popup in dark mode.',
    'Weights and breakpoints moved onto the tokens, the inline styles that scripts set too, and a step scale for page rhythm (28 to 80 px).',
    'Icons in place of emoji in collect, and licence badges in collect’s layer picker.',
    'One date format on layer rows.',
    'collect’s map camera honours reduced motion, as bharatlas.com’s does.',
  ]);
}

/** The page body (inside main.sheet). */
export function designPageBody() {
  return [
    `<h1 class="page-title">Design</h1>
<p class="page-lead">The rules and parts that make bharatlas.com and collect look and work as one. This page is built from the same tokens the sites use, so every value here is the real one.</p>`,
    section('principles', 'Principles', list([
      '<strong>A survey sheet.</strong> Grid paper behind the page, white sheets on it, edged in navy, with labels in monospace.',
      '<strong>India’s colours, with jobs.</strong> Saffron acts, green means open, navy is the ink.',
      '<strong>Readable by everyone.</strong> AA contrast, 44 px targets, visible focus, light and dark.',
      '<strong>Light.</strong> System fonts, no images for decoration, small pages.',
    ])),
    section('colour', 'Colour', colours()),
    section('type', 'Type', type()),
    section('space', 'Spacing', space()),
    section('shape', 'Corners, borders and shadows', shape()),
    section('system', 'Layers, motion, breakpoints and icons', system()),
    section('buttons', 'Buttons', buttons()),
    section('parts', 'Chips, badges and fields', parts()),
    section('access', 'Accessibility', access()),
    section('content', 'Words and numbers', content()),
    section('logo', 'Logo', logo()),
    section('maps', 'Maps and data', maps()),
    section('governance', 'Governance', governance()),
    section('planned', 'Planned', planned()),
  ].join('\n');
}
