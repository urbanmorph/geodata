// Stable design tokens + nav + footer, in the "survey sheet" look (Direction A):
// grid paper behind the page, 1.5px navy edges, 4px corners, a navy offset shadow
// on actions, system monospace for map-sheet labels. Colours and the logo come from
// shared/brand.mjs (saffron / India green / chakra navy). Type scale
// (--fs-*) 12/13/15/16/18/22/24/32/44/72: every font size on every page uses it
// (tests/type-scale.test.ts). Radii 4/6/8/12. Pure module so vitest can test
// renderNav() etc.
import { themeDecls, wordmarkHtml, WORDMARK_CSS, PALETTE } from '../../shared/brand.mjs';
import { footerHtml } from '../../shared/footer.mjs';

export const TOKENS = `
  :root {
    --fs-xs: 12px; --fs-sm: 13px; --fs-base: 15px; --fs-md: 16px; --fs-lg: 18px;
    --fs-xl: 22px; --fs-2xl: 24px; --fs-3xl: 32px; --fs-4xl: 44px; --fs-display: 72px;
    --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
    --sp-5: 20px; --sp-6: 24px; --sp-7: 32px; --sp-8: 48px;
    --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px;
    /* Paper behind the page, white panels on it; --bg-card is the hover / selected tint. */
    --bg: #F3F6F1; --bg-elevated: #ffffff; --bg-card: #E9EFEA;
    --muted: #4B5563; --muted-strong: #374151;
    --subtle: #9ca3af; --line: #D5DED7; --line-bright: #B8C4BC;
    /* Survey sheet: land fill, the navy edge and its offset shadow, the grid. */
    --land: #E6F2EA; --edge: ${PALETTE.navy}; --grid: rgba(18, 128, 74, .07);
    --shadow: 4px 4px 0 var(--edge); --shadow-sm: 3px 3px 0 var(--edge);
    --font-mono: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace;
    ${themeDecls('light')}
    --ok: #16a34a; --warn: #d97706; --err: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a; --bg-elevated: #15151a; --bg-card: #1a1a1f;
      --muted: #9ca3af; --muted-strong: #d4d4d8;
      --subtle: #525252; --line: #262626; --line-bright: #404040;
      --land: #13261C; --edge: #C8D0E3; --grid: rgba(63, 203, 126, .06);
      ${themeDecls('dark')}
      --ok: #4ade80; --warn: #fbbf24; --err: #f87171;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: var(--fg); }
  /* Grid paper on the root, so it fills the window, not just body's column. */
  html {
    background: var(--bg);
    background-image: linear-gradient(var(--grid) 1px, transparent 1px), linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 48px 48px;
  }
  body { font: var(--fs-base)/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Inter", sans-serif; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  a:focus-visible, button:focus-visible, [role=button]:focus-visible,
  input:focus-visible, textarea:focus-visible, select:focus-visible {
    outline: 2px solid var(--accent-strong) !important;
    outline-offset: 2px !important;
    border-radius: var(--radius-sm);
  }
  .skip-link {
    position: absolute; left: -9999px; top: var(--sp-2);
    background: var(--bg); color: var(--accent);
    padding: var(--sp-2) var(--sp-3); border: 1px solid var(--line);
    border-radius: var(--radius-md); z-index: 1000;
  }
  .skip-link:focus { left: var(--sp-2); }
  main :is(p, li, dd) a { text-decoration: underline; text-underline-offset: 2px; }
  /* Page column: one width for every page, so the logo, nav and footer stay put
     between pages (reading text keeps a 720px measure inside it). The header is
     a full-width bar whose content lines up with that column. */
  :root { --page-max: 1120px; }
  html { overflow-x: clip; }
  body { padding-top: 0 !important; }
  .site-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--sp-4); flex-wrap: wrap;
    margin-inline: calc(50% - 50vw); margin-bottom: var(--sp-6);
    padding: 12px max(16px, calc(50vw - var(--page-max) / 2 + 24px));
    background: var(--bg-elevated); border-bottom: 1.5px solid var(--edge);
  }
  ${WORDMARK_CSS}
  .site-brand { font-size: var(--fs-xl); }
  .site-brand .tagline { color: var(--muted); font-weight: 400; margin-left: 6px; font-size: var(--fs-base); }
  .site-nav { display: flex; gap: var(--sp-5); flex-wrap: wrap; align-items: center; }
  /* Tablets: the tagline gives way so Home … Add a map stay on one line. */
  @media (max-width: 900px) { .site-brand .tagline { display: none; } .site-nav { gap: var(--sp-3); } }
  .site-nav a {
    color: var(--muted); text-decoration: none; font-size: var(--fs-base); font-weight: 500;
    padding: 6px 2px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }
  .site-nav a:hover { color: var(--fg); }
  .site-nav a[data-active] { color: var(--fg); font-weight: 650; }
  .site-nav a.nav-cta {
    min-height: 44px; padding: 0 16px; color: var(--fg); font-weight: 650;
    border: 1.5px solid var(--edge); border-radius: var(--radius-sm); box-shadow: var(--shadow-sm);
  }
  .site-nav a.nav-cta:hover, .site-nav a.nav-cta[data-active] { background: var(--accent-fill); color: var(--on-accent-fill); text-decoration: none; }
  .site-nav a[data-active]:not(.nav-cta) { box-shadow: inset 0 -3px 0 var(--accent-fill); }
  /* mobile hamburger (CSS-only, checkbox toggle) */
  .nav-toggle { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
  .nav-burger {
    display: none; align-items: center; justify-content: center;
    min-width: 44px; min-height: 44px; font-size: var(--fs-xl); line-height: 1;
    color: var(--fg); cursor: pointer; border: 1px solid var(--line); border-radius: var(--radius-md);
  }
  .nav-toggle:focus-visible ~ .nav-burger { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
  @media (max-width: 640px) {
    .site-header { gap: var(--sp-2); margin-bottom: var(--sp-4); position: relative; align-items: center; }
    .site-brand .tagline { display: none; }
    .nav-burger { display: inline-flex; }
    .site-nav { display: none; flex-direction: column; align-items: stretch; gap: 0; width: 100%; margin-top: var(--sp-2); }
    .nav-toggle:checked ~ .site-nav { display: flex; }
    .site-nav a { width: 100%; padding: 12px 4px; min-height: 48px; border-top: 1px solid var(--line); }
    .site-nav a.nav-cta { border-radius: 0; border-width: 1px 0 0; padding: 12px 4px; }
  }
  /* "Install app": shown by src/install.ts only where install is possible.
     Desktop: after the nav links. Mobile: between the wordmark and the burger. */
  .site-nav { margin-left: auto; }
  .install-app {
    display: inline-flex; align-items: center; min-height: 32px; padding: 0 var(--sp-3);
    font: inherit; font-size: var(--fs-sm); font-weight: 500; color: var(--accent);
    background: transparent; border: 1px solid var(--line-bright); border-radius: 999px; cursor: pointer;
  }
  .install-app:hover { border-color: var(--accent); }
  .install-app[hidden] { display: none; }
  @media (max-width: 640px) {
    .install-app { order: 1; margin-left: auto; }
    .nav-burger { order: 2; }
    .site-nav { order: 3; }
  }
  dialog.install-guide {
    max-width: min(360px, calc(100vw - 32px)); padding: var(--sp-5);
    color: var(--fg); background: var(--bg-elevated);
    border: 1px solid var(--line); border-radius: var(--radius-xl);
  }
  dialog.install-guide::backdrop { background: rgba(0, 0, 0, .45); }
  /* Reset per-page h2 / li styles (uppercase headings, "›" bullets): the dialog lives on <body>. */
  .install-guide h2 {
    margin: 0 0 var(--sp-3); padding: 0; border: 0; font-size: var(--fs-md); font-weight: 600;
    text-transform: none; letter-spacing: normal; color: var(--fg);
  }
  .install-guide ol { margin: 0 0 var(--sp-4); padding-left: var(--sp-5); list-style: decimal; color: var(--muted-strong); }
  .install-guide li { padding: 0; }
  .install-guide li::before { content: none; }
  .install-guide li + li { margin-top: var(--sp-2); }
  .install-guide form { display: flex; justify-content: flex-end; }
  .install-guide button {
    min-height: 44px; padding: 0 var(--sp-5); font: inherit; font-weight: 600; color: var(--on-accent-fill);
    background: var(--accent-fill); border: 0; border-radius: var(--radius-md); cursor: pointer;
  }
  .install-guide button:hover { background: var(--accent-fill-hover); }
  /* Content pages: one type scale for every page (the home page's too). */
  .page-title { margin: 24px 0 14px; max-width: 760px; font-size: var(--fs-4xl); line-height: 1.04; font-weight: 850; letter-spacing: -.03em; text-wrap: balance; }
  /* A map-sheet label: monospace, green, above a title or beside a count. */
  .sheet-note { margin: 0 0 12px; font: 600 var(--fs-sm) var(--font-mono); color: var(--brand-green); }
  .page-lead { margin: 0 0 28px; max-width: 660px; font-size: var(--fs-lg); line-height: 1.55; color: var(--muted); }
  .section-title, .prose h2, :where(.page main) h2 { margin: 44px 0 14px; font-size: var(--fs-2xl); line-height: 1.2; font-weight: 850; letter-spacing: -.02em; color: var(--fg); text-transform: none; }
  .prose :is(p, ul, ol, dl) { max-width: 720px; } /* the sheet spans the column; its text keeps a reading measure */
  .prose ul { list-style: none; margin: 0 0 16px; padding: 0; }
  .prose li { position: relative; padding: 4px 0 4px 20px; }
  .prose li::before { content: ""; position: absolute; left: 4px; top: .9em; width: 6px; height: 6px; border-radius: 50%; background: var(--accent-fill); }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 0 20px; border: 1.5px solid var(--edge); border-radius: var(--radius-sm); font: inherit; font-size: var(--fs-md); font-weight: 750; text-decoration: none !important; cursor: pointer; }
  .btn--fill { background: var(--accent-fill); color: var(--on-accent-fill) !important; box-shadow: var(--shadow); }
  .btn--fill:hover { background: var(--accent-fill-hover); }
  .btn--fill:active { box-shadow: none; transform: translate(4px, 4px); }
  .btn--line { background: var(--bg-elevated); color: var(--fg) !important; }
  .btn--line:hover { background: var(--land); }
  @media (max-width: 640px) {
    .page-title { font-size: var(--fs-3xl); }
    .page-lead { font-size: var(--fs-md); }
    .section-title, .prose h2, :where(.page main) h2 { margin-top: 36px; font-size: var(--fs-xl); }
  }
  /* Content pages: <body class="page">. One column and the survey-sheet details,
     so pages keep only what is theirs (tests/page-system.test.ts). */
  body.page { max-width: var(--page-max); margin: 0 auto; padding: 0 24px 80px; line-height: 1.6; }
  .page main :is(p, ul, ol) { max-width: 720px; }
  /* :where() keeps these defaults below any page's own heading rules. */
  :where(.page main) h3 { margin: var(--sp-4) 0 var(--sp-1); font-size: var(--fs-md); font-weight: 750; }
  .page code { font: var(--fs-sm) var(--font-mono); background: var(--bg-card); padding: 1px 5px; border-radius: var(--radius-sm); color: var(--fg); }
  .page pre {
    margin: var(--sp-3) 0; padding: 16px 18px; overflow-x: auto; font: var(--fs-sm)/1.65 var(--font-mono);
    color: ${PALETTE.white}; background: ${PALETTE.navy}; border: 1.5px solid var(--edge); border-radius: var(--radius-sm);
    box-shadow: 6px 6px 0 var(--brand-green);
  }
  .page pre code { font: inherit; color: inherit; background: none; padding: 0; }
  .page table { width: 100%; border-collapse: collapse; margin: var(--sp-2) 0; font-size: var(--fs-base); background: var(--bg-elevated); border: 1.5px solid var(--edge); }
  .page th, .page td { text-align: left; vertical-align: top; padding: 10px 14px; border-bottom: 1px solid var(--line); }
  .page th { font: 600 var(--fs-xs) var(--font-mono); color: var(--muted); border-bottom: 1.5px solid var(--edge); }
  .page td { color: var(--muted); overflow-wrap: anywhere; } /* long paths wrap, so tables fit a phone */
  .page td code { font-size: var(--fs-xs); }
  .table-wrap { overflow-x: auto; }
  .note { padding: var(--sp-3) var(--sp-4); background: var(--bg-elevated); border: 1.5px solid var(--edge); border-radius: var(--radius-sm); }
  .note p { margin: 0; }
  .badge {
    display: inline-block; vertical-align: middle; padding: 2px 8px; font: 600 var(--fs-xs) var(--font-mono); letter-spacing: 0;
    color: var(--fg); background: var(--bg-elevated); border: 1.5px solid var(--edge); border-radius: var(--radius-sm);
  }
  .badge--stable { background: color-mix(in srgb, var(--brand-green) 18%, var(--bg-elevated)); }
  .badge--soon { color: var(--muted); }
  @media (max-width: 640px) {
    body.page { padding: 0 14px 60px; }
    .page pre { font-size: var(--fs-xs); }
    .page th, .page td { padding: 8px 10px; }
  }
  /* Shared by the home page and /layers: the search box text, its status line,
     and the theme symbols (THEME_GLYPH) in the legend and the theme index. */
  .catalog-search { flex: 1; min-width: 0; padding: 6px 0; font: var(--fs-md) ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: transparent; border: none; outline: none; }
  .catalog-search::placeholder { color: var(--muted); }
  .catalog-search:focus-visible { outline: none !important; }
  .search-meta { color: var(--muted); font: var(--fs-sm) var(--font-mono); }
  .legend-glyph path { stroke: var(--edge); stroke-width: 1.6; stroke-linejoin: round; }
  .legend-glyph .ink { fill: var(--fg); }
  /* Reading pages: the text on a white sheet, sections numbered in the margin's voice. */
  main.sheet {
    margin: var(--sp-2) 0 0; padding: clamp(20px, 4vw, 56px); counter-reset: sheet-section;
    background: var(--bg-elevated); border: 1.5px solid var(--edge);
  }
  main.sheet > .page-title:first-child { margin-top: 0; }
  /* The number is decoration: "/ ''" keeps it out of the heading's accessible name. */
  main.sheet h2:not(.unnumbered)::before {
    counter-increment: sheet-section; content: "§" counter(sheet-section) / "";
    display: block; margin-bottom: 4px; font: 600 var(--fs-sm) var(--font-mono); letter-spacing: 0; color: var(--brand-green);
  }
  /* Reading pages as a ledger: each <section>'s heading in a 200px left column,
     its text beside it at the reading measure; .wide spans both. Phones stack. */
  main.sheet > section {
    display: grid; grid-template-columns: 200px minmax(0, 720px); gap: var(--sp-3) 40px; align-items: start;
    padding: var(--sp-6) 0; border-top: 1px solid var(--line);
  }
  main.sheet > section > * { margin-top: 0; margin-bottom: 0; }
  main.sheet > section > h2 { grid-column: 1; font-size: var(--fs-xl); }
  main.sheet > section > :not(h2) { grid-column: 2; }
  main.sheet > section > .wide { grid-column: 1 / -1; max-width: none; }
  /* A list whose items start with a label (span.k) set beside their text. */
  .prose .pairs { list-style: none; margin: 0; padding: 0; }
  .prose .pairs > li { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 4px var(--sp-4); padding: 10px 0; border-bottom: 1px solid var(--line); }
  .prose .pairs > li:last-child { border-bottom: 0; }
  .prose .pairs > li::before { display: none; }
  .pairs .k { font-weight: 800; color: var(--fg); }
  @media (max-width: 760px) {
    main.sheet > section { grid-template-columns: 1fr; }
    main.sheet > section > :not(h2) { grid-column: 1; }
    .prose .pairs > li { grid-template-columns: 1fr; }
  }
  .site-footer {
    margin-top: var(--sp-8); padding-top: var(--sp-5);
    border-top: 1.5px solid var(--edge);
    color: var(--muted); font: var(--fs-xs)/1.7 var(--font-mono);
  }
  .site-footer p { margin: 0 0 var(--sp-2); }
  .site-footer a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
  .site-footer a:hover { color: var(--fg); }
`;

// The mockup's nav. `keys` are the page keys a link is active on; labels are
// HTML (escaped). Adding a map (/preview) is the outlined button after them.
export const NAV_LINKS = [
  { keys: ['home'], href: '/', label: 'Home' },
  { keys: ['layers'], href: '/layers', label: 'Layers' },
  { keys: ['collect'], href: 'https://collect.bharatlas.com', label: 'Collect' },
  { keys: ['docs', 'mcp'], href: '/docs', label: 'API &amp; MCP' },
  { keys: ['about'], href: '/about', label: 'About' },
];

/** The site header. Edge-rendered pages pass installScript: false (no /src there). */
export function renderNav(activeKey, { installScript = true } = {}) {
  return `<a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      ${wordmarkHtml({ tagline: "India's open atlas" })}
      <input type="checkbox" id="nav-toggle" class="nav-toggle" />
      <label for="nav-toggle" class="nav-burger" aria-label="Menu">☰</label>
      <nav class="site-nav" id="site-nav" aria-label="Primary">
        ${NAV_LINKS.map(
          (l) =>
            `<a href="${l.href}"${l.keys.includes(activeKey) ? ' data-active' : ''}${l.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${l.label}</a>`,
        ).join('\n        ')}
        <a class="nav-cta" href="/preview"${activeKey === 'preview' ? ' data-active' : ''}>Add a map</a>
      </nav>
      <button type="button" id="install-app" class="install-app" hidden>Install app</button>
    </header>${installScript ? '\n    <script type="module" src="/src/install.ts"></script>' : ''}`;
}

// One footer for every surface (shared/footer.mjs).
export const FOOTER = footerHtml();
