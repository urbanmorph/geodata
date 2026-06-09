// Stable design tokens + nav + footer — kept in sync with mdshare
// (urbanmorph stable). Indigo accent. Type scale 11/12/13/14/16/20/28/36.
// Radii 4/6/8/12. Pure module so vitest can test renderNav() etc.

export const TOKENS = `
  :root {
    --fs-xs: 11px; --fs-sm: 12px; --fs-md: 13px; --fs-base: 14px;
    --fs-lg: 16px; --fs-xl: 20px; --fs-2xl: 28px; --fs-display: 36px;
    --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
    --sp-5: 20px; --sp-6: 24px; --sp-7: 32px; --sp-8: 48px;
    --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px;
    --bg: #ffffff; --bg-elevated: #fafafa; --bg-card: #f5f5f5;
    --fg: #0a0a0a; --muted: #525965; --muted-strong: #374151;
    --subtle: #9ca3af; --line: #e5e7eb; --line-bright: #d1d5db;
    --accent: #4f46e5; --accent-strong: #4338ca;
    --accent-fill: #4f46e5; --accent-fill-hover: #4338ca;
    --ok: #16a34a; --warn: #d97706; --err: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0a0a0a; --bg-elevated: #15151a; --bg-card: #1a1a1f;
      --fg: #ededed; --muted: #9ca3af; --muted-strong: #d4d4d8;
      --subtle: #525252; --line: #262626; --line-bright: #404040;
      --accent: #818cf8; --accent-strong: #6366f1;
      --accent-fill: #4f46e5; --accent-fill-hover: #4338ca;
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
  .site-header {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: var(--sp-4); flex-wrap: wrap; margin-bottom: var(--sp-6);
  }
  .site-brand {
    font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.01em;
    color: var(--fg); text-decoration: none;
  }
  .site-brand:hover { text-decoration: none; }
  .site-brand .mark-accent { color: var(--accent); }
  .site-brand .tagline { color: var(--muted); font-weight: 400; margin-left: 6px; font-size: var(--fs-base); }
  .site-nav { display: flex; gap: var(--sp-3); flex-wrap: wrap; align-items: center; }
  .site-nav a {
    color: var(--muted); text-decoration: none; font-size: var(--fs-base);
    padding: 6px 2px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
  }
  .site-nav a:hover { color: var(--fg); }
  .site-nav a[data-active] { color: var(--fg); font-weight: 500; }
  @media (max-width: 480px) {
    .site-header { gap: var(--sp-2); margin-bottom: var(--sp-4); }
    .site-brand .tagline { display: none; }
    .site-nav { gap: var(--sp-2); }
    .site-nav a { font-size: var(--fs-sm); }
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

export const NAV_LINKS = [
  { k: 'catalog', href: '/', label: 'catalog' },
  { k: 'preview', href: '/preview', label: 'contribute' },
  { k: 'docs', href: '/docs', label: 'docs' },
  { k: 'mcp', href: '/mcp', label: 'mcp' },
  { k: 'about', href: '/about', label: 'about' },
];

export function renderNav(activeKey) {
  return `<a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      <a class="site-brand" href="/">bhar<span class="mark-accent">atlas</span><span class="tagline">India's open atlas</span></a>
      <nav class="site-nav">
        ${NAV_LINKS.map(
          (l) =>
            `<a href="${l.href}"${l.k === activeKey ? ' data-active' : ''}${l.href.startsWith('http') ? ' target="_blank" rel="noopener"' : ''}>${l.label}</a>`,
        ).join('\n        ')}
      </nav>
    </header>`;
}

export const FOOTER = `<footer class="site-footer">
      <p>Open licences only. Each layer carries its source link on the card.</p>
      <p>
        <a href="/privacy">privacy</a> ·
        <a href="/terms">terms</a> ·
        <a href="https://github.com/urbanmorph/geodata">code</a> ·
        made by <a href="https://urbanmorph.com">urbanmorph</a> ·
        a digital commons · <a href="https://pdgi.org">pdgi.org</a>
      </p>
    </footer>`;
