import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { minifyInlineStyles, pruneUnusedTokens } from '../scripts/minify-inline-css.mjs';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');

describe('minifyInlineStyles', () => {
  it('minifies every <style> block and leaves the rest of the page as it is', async () => {
    const page = '<head>\n  <style>\n    :root {\n      --a: 1px;\n    }\n    /* note */\n    .b { color: red; }\n  </style>\n</head>\n<body>\n  <p>  keep   me  </p>\n<style media="print">\n  .c {  display: none;  }\n</style></body>';
    expect(await minifyInlineStyles(page)).toBe(
      '<head>\n  <style>:root{--a: 1px}.b{color:red}\n</style>\n</head>\n<body>\n  <p>  keep   me  </p>\n<style media="print">.c{display:none}\n</style></body>');
  });

  it('leaves a page without styles unchanged', async () => {
    expect(await minifyInlineStyles('<p>no styles</p>')).toBe('<p>no styles</p>');
  });
});

describe('pruneUnusedTokens', () => {
  const page = '<style>:root { --a: 1px; --b: var(--c); --c: red; --d: 2px; --e: 3px }\n@media (x) { :root { --a: 9px; --d: 8px; } }\n.x { margin: var(--a); color: var(--b); }</style><p style="padding: var(--e)"></p>';
  it('keeps what the page reads, directly or through another token, and drops the rest', () => {
    const out = pruneUnusedTokens(page);
    expect(out).toContain('--a: 1px;');
    expect(out).toContain('--b: var(--c);');
    expect(out).toContain('--c: red;');
    expect(out).toContain('--e: 3px');
    expect(out).not.toContain('--d:');
    expect(out).toContain('--a: 9px;');
  });
  it('keeps tokens the scripts read', () => {
    expect(pruneUnusedTokens(page, new Set(['--d']))).toContain('--d: 2px;');
  });
  it('only prunes when asked', async () => {
    expect(await minifyInlineStyles('<style>:root { --z: 1px }</style>')).toContain('--z');
    expect(await minifyInlineStyles('<style>:root { --z: 1px }</style>', { keepTokens: new Set() })).not.toContain('--z');
  });
});

describe('the built pages ship minified inline CSS', () => {
  for (const page of ['index.html', 'layers.html', 'about.html', 'docs.html']) {
    it(page, () => {
      const css = read(page).match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
      expect(css.length).toBeGreaterThan(0);
      expect(css).not.toMatch(/\n\s+\S/);   // no indented lines left
    });
  }
});
