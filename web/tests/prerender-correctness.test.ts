// What the prerender puts on /docs, /about, /mcp, /layers and the home page (review 2026-11-18):
// FAQ text that reads as written and matches its JSON-LD, themes in the catalogue's order,
// counts from their source, no build-time "N ago", and catalogue text spliced in literally.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: .mjs import, no type defs
import { fillTemplate } from '../scripts/fill-template.mjs';
import { DEFAULT_LOCATE_LAYERS } from '../functions/lib/locate-layers';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
const catalog = JSON.parse(read('../catalog.json')) as { categories: Record<string, string> };

const decode = (s: string) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
/** The text a reader sees in an HTML fragment. */
const text = (html: string) =>
  decode(html.replace(/<\/?(p|br)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

function faqLd(html: string): { q: string; a: string }[] {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)!;
  const data = JSON.parse(m[1].replace(/\\u003c/g, '<'));
  const faq = (data['@graph'] || [data]).find((n: { '@type': string }) => n['@type'] === 'FAQPage');
  return faq.mainEntity.map((e: { name: string; acceptedAnswer: { text: string } }) => ({
    q: e.name.replace(/\s+/g, ' ').trim(), a: e.acceptedAnswer.text.replace(/\s+/g, ' ').trim(),
  }));
}
// A bare & is read by the browser as an entity when one fits ("&sect" in "&select" is a §).
const BARE_AMP = /&(?!amp;|lt;|gt;|quot;|#\d+;|#x[0-9a-f]+;)/i;
const pairs = (html: string, qRe: RegExp, aRe: RegExp) => {
  expect(html).not.toMatch(BARE_AMP);
  const qs = [...html.matchAll(qRe)].map((m) => text(m[1]));
  const as = [...html.matchAll(aRe)].map((m) => text(m[1]));
  return qs.map((q, i) => ({ q, a: as[i] }));
};

describe('FAQ: the visible questions and the FAQPage JSON-LD are the same text', () => {
  it('/docs, with "&select=" shown as typed', () => {
    const html = read('docs.html');
    const start = html.indexOf('Common questions');
    const sec = html.slice(start, html.indexOf('<h2>For LLMs', start));
    const visible = pairs(sec, /<h3>([\s\S]*?)<\/h3>/g, /<h3>[\s\S]*?<\/h3>\s*<p>([\s\S]*?)<\/p>/g);
    expect(visible).toEqual(faqLd(html));
    expect(visible.map((p) => p.a).join(' ')).toContain('?where=col=val&select=col1,col2&group_by=col');
    expect(sec).not.toContain('§');
  });
  it('/about', () => {
    const html = read('about.html');
    const dl = html.match(/<dl class="faq wide">([\s\S]*?)<\/dl>/)![1];
    const visible = pairs(dl, /<dt[^>]*>([\s\S]*?)<\/dt>/g, /<dd>([\s\S]*?)<\/dd>/g);
    expect(visible.length).toBeGreaterThanOrEqual(5);
    expect(visible).toEqual(faqLd(html));
  });
  it('/mcp', () => {
    const html = read('mcp.html');
    const faq = html.slice(html.indexOf('What you can ask'), html.indexOf('query tools</h2>'));
    const visible = pairs(faq, /<p class="question">([\s\S]*?)<\/p>/g, /<p class="answer">([\s\S]*?)<\/p>/g);
    expect(visible.length).toBeGreaterThanOrEqual(8);
    expect(visible).toEqual(faqLd(html));
  });
  it('/docs FAQ says "layers", never "catalog"', () => {
    for (const { q, a } of faqLd(read('docs.html'))) expect(`${q} ${a}`).not.toMatch(/catalog/i);
  });
});

describe('counts from their source', () => {
  const n = DEFAULT_LOCATE_LAYERS.length;
  it(`locate's default layer count (${n}) on /docs, /mcp and in the MCP tool text`, () => {
    expect(read('docs.html')).toContain(`across ${n} admin and zone layers`);
    const mcp = read('mcp.html');
    expect(mcp).toContain(`checks ${n} layers in one call`);
    expect(mcp).not.toMatch(/\b12 layers\b/);
    expect(read('../mcp/read-tools.js')).toContain(`the default: ${n} essential admin/zone layers`);
  });
  it('/mcp meta names the real layer count', () => {
    const total = read('layers.html').match(/All (\d+) of India/)![1];
    const mcp = read('mcp.html');
    expect(mcp).not.toContain('77 geo layers');
    expect(mcp).toContain(`to ${total} geo layers`);
  });
});

describe('/layers themes', () => {
  const layers = read('layers.html');
  const sections = [...layers.matchAll(/<section class="category-section" id="([a-z-]+)"/g)].map((m) => m[1]);
  it('follow the catalogue order, water included and other last', () => {
    const order = Object.keys(catalog.categories);
    expect(sections).toEqual(order.filter((c) => sections.includes(c)));
    expect(sections).toContain('water');
    if (sections.includes('other')) expect(sections.at(-1)).toBe('other');
    for (const s of sections) expect(order, s).toContain(s);
  });
  it('the theme index counts match the section counts', () => {
    const idx = layers.match(/<nav class="theme-index"[^>]*>([\s\S]*?)<\/nav>/)![1];
    for (const m of idx.matchAll(/href="#([a-z-]+)"[\s\S]*?theme-index__n">(\d+)</g)) {
      const sec = layers.match(new RegExp(`id="${m[1]}" data-category[\\s\\S]*?category-section__count">(\\d+) layer`))!;
      expect(sec[1], m[1]).toBe(m[2]);
    }
  });
  it('carry no build-time "updated N ago" (the panel shows the date)', () => {
    expect(layers).not.toContain('row__freshness');
    expect(layers).not.toMatch(/updated \d+(d|w|mo|y)\b[^<]* ago/);
    expect(read('layers.template.html')).not.toContain('row__freshness');
  });
});

describe('home JSON-LD', () => {
  it('has no breadcrumb trail (the home page is the root)', () => {
    const html = read('index.html');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)!;
    expect(m[1]).not.toContain('BreadcrumbList');
  });
});

describe('fillTemplate', () => {
  it('splices values in literally: $& and $\' in catalogue text stay as typed', () => {
    expect(fillTemplate('<a><!-- X --></a><!-- Y -->', { X: "50$& off $' now", Y: '$$' })).toBe("<a>50$& off $' now</a>$$");
  });
  it('fills every occurrence, leaves unknown placeholders, and never re-fills a value', () => {
    expect(fillTemplate('<!-- N --> <!-- N --> <!-- Z --> <!-- Q -->', { N: '<!-- Z -->', Z: 'z' }))
      .toBe('<!-- Z --> <!-- Z --> z <!-- Q -->');
  });
});
