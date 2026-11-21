import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { minifyInlineStyles } from '../scripts/minify-inline-css.mjs';

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

describe('the built pages ship minified inline CSS', () => {
  for (const page of ['index.html', 'layers.html', 'about.html', 'docs.html']) {
    it(page, () => {
      const css = read(page).match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
      expect(css.length).toBeGreaterThan(0);
      expect(css).not.toMatch(/\n\s+\S/);   // no indented lines left
    });
  }
});
