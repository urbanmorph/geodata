// Stable design tokens + nav + footer. Colours and the logo come from
// shared/brand.mjs (saffron / India green / chakra navy). Type scale
// 11/12/13/14/16/20/28/36. Radii 4/6/8/12. Pure module so vitest can test
// renderNav() etc.
import { themeDecls, wordmarkHtml, WORDMARK_CSS } from '../../shared/brand.mjs';
import { footerHtml } from '../../shared/footer.mjs';

export const TOKENS = `
  :root {
    --fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-base: 14px;
    --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 28px; --fs-display: 36px;
    --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
    --sp-5: 20px; --sp-6: 24px; --sp-7: 32px; --sp-8: 48px;
    --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px;
    --bg: #ffffff; --bg-elevated: #fafafa; --bg-card: #f5f5f5;
    --muted: #525965; --muted-strong: #374151;
    --subtle: #9ca3af; --line: #e5e7eb; --line-bright: #d1d5db;
    ${themeDecls('light')}
    --ok: #16a34a; --warn: #d97706; --err: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a; --bg-elevated: #15151a; --bg-card: #1a1a1f;
      --muted: #9ca3af; --muted-strong: #d4d4d8;
      --subtle: #525252; --line: #262626; --line-bright: #404040;
      ${themeDecls('dark')}
      --ok: #4ade80; --warn: #fbbf24; --err: #f87171;
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
  body {
    font: var(--fs-base)/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Inter", sans-serif;
  }
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
  main :is(p, li) a { text-decoration: underline; text-underline-offset: 2px; }
  /* Page column: each page sets --page-max (its body max-width). The header is
     a full-width bar whose content lines up with that column. */
  :root { --page-max: 880px; }
  html { overflow-x: clip; }
  body { padding-top: 0 !important; }
  .site-header {
    display: flex; align-items: center; justify-content: space-between;
    gap: var(--sp-4); flex-wrap: wrap;
    margin-inline: calc(50% - 50vw); margin-bottom: var(--sp-6);
    padding: 12px max(16px, calc(50vw - var(--page-max) / 2 + 24px));
    background: var(--bg); border-bottom: 1px solid var(--line);
  }
  ${WORDMARK_CSS}
  .site-brand { font-size: var(--fs-lg); }
  .site-brand .tagline { color: var(--muted); font-weight: 400; margin-left: 6px; font-size: var(--fs-base); }
  .site-nav { display: flex; gap: var(--sp-5); flex-wrap: wrap; align-items: center; }
  .site-nav a {
    color: var(--muted); text-decoration: none; font-size: 15px; font-weight: 500;
    padding: 6px 2px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }
  .site-nav a:hover { color: var(--fg); }
  .site-nav a[data-active] { color: var(--fg); font-weight: 650; }
  .site-nav a.nav-cta {
    min-height: 40px; padding: 0 14px; color: var(--fg); font-weight: 650;
    border: 1.5px solid var(--line-bright); border-radius: 10px;
  }
  .site-nav a.nav-cta:hover, .site-nav a.nav-cta[data-active] { border-color: var(--accent-fill); text-decoration: none; }
  /* mobile hamburger (CSS-only, checkbox toggle) */
  .nav-toggle { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
  .nav-burger {
    display: none; align-items: center; justify-content: center;
    min-width: 44px; min-height: 44px; font-size: 20px; line-height: 1;
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
    font: inherit; font-size: var(--fs-md); font-weight: 500; color: var(--accent);
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
    margin: 0 0 var(--sp-3); padding: 0; border: 0; font-size: var(--fs-lg); font-weight: 600;
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
  .page-title { margin: 24px 0 14px; max-width: 760px; font-size: 44px; line-height: 1.06; font-weight: 760; letter-spacing: -.035em; text-wrap: balance; }
  .page-lead { margin: 0 0 28px; max-width: 660px; font-size: 18px; line-height: 1.55; color: var(--muted); }
  .section-title, .prose h2 { margin: 44px 0 14px; font-size: 24px; line-height: 1.2; font-weight: 720; letter-spacing: -.02em; color: var(--fg); text-transform: none; }
  .prose { max-width: 720px; }
  .prose ul { list-style: none; margin: 0 0 16px; padding: 0; }
  .prose li { position: relative; padding: 4px 0 4px 20px; }
  .prose li::before { content: ""; position: absolute; left: 4px; top: .9em; width: 6px; height: 6px; border-radius: 50%; background: var(--accent-fill); }
  .btn { display: inline-flex; align-items: center; gap: 8px; min-height: 48px; padding: 0 20px; border-radius: 12px; font-size: 16px; font-weight: 700; text-decoration: none !important; }
  .btn--fill { background: var(--accent-fill); color: var(--on-accent-fill) !important; }
  .btn--fill:hover { background: var(--accent-fill-hover); }
  .btn--line { border: 1.5px solid var(--line-bright); color: var(--fg) !important; }
  .btn--line:hover { border-color: var(--accent-fill); }
  @media (max-width: 640px) {
    .page-title { font-size: 32px; }
    .page-lead { font-size: 16px; }
    .section-title, .prose h2 { margin-top: 36px; font-size: 21px; }
  }
  .site-footer {
    margin-top: var(--sp-8); padding-top: var(--sp-5);
    border-top: 1px solid var(--line);
    color: var(--muted); font-size: var(--fs-sm); line-height: 1.7;
  }
  .site-footer p { margin: 0 0 var(--sp-2); }
  .site-footer a { color: var(--muted); text-decoration: underline; text-underline-offset: 2px; }
  .site-footer a:hover { color: var(--fg); }
`;

// The mockup's nav. `keys` are the page keys a link is active on; labels are
// HTML (escaped). Adding a map (/preview) is the outlined button after them.
export const NAV_LINKS = [
  { keys: ['catalog'], href: '/', label: 'Layers' },
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
