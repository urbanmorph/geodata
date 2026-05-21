import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function metaContent(html: string, name: string, attr = 'name'): string | null {
  const m = html.match(new RegExp(`<meta\\s+${attr}="${name}"[^>]*content="([^"]+)"`));
  return m ? m[1] : null;
}

describe('SEO — meta description length budget (Google truncates ~158)', () => {
  // Targeting the Google snippet ceiling. Below 158 ensures the
  // description displays in full on the SERP without "...".
  const MAX = 158;

  it('home description ≤ 158 chars', () => {
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    const desc = metaContent(html, 'description');
    expect(desc).not.toBeNull();
    expect(desc!.length, `home desc: ${desc!.length} chars: "${desc}"`).toBeLessThanOrEqual(MAX);
  });

  it('about description ≤ 158 chars', () => {
    const html = readFileSync(resolve(__dirname, '..', 'about.html'), 'utf8');
    const desc = metaContent(html, 'description');
    expect(desc).not.toBeNull();
    expect(desc!.length, `about desc: ${desc!.length} chars: "${desc}"`).toBeLessThanOrEqual(MAX);
  });

  it('preview description ≤ 158 chars', () => {
    const html = readFileSync(resolve(__dirname, '..', 'preview.html'), 'utf8');
    const desc = metaContent(html, 'description');
    expect(desc).not.toBeNull();
    expect(desc!.length, `preview desc: ${desc!.length} chars: "${desc}"`).toBeLessThanOrEqual(MAX);
  });
});

describe('SEO — every prerendered page has an h1', () => {
  for (const page of ['index.html', 'about.html', 'preview.html']) {
    it(`${page} has a non-empty <h1>`, () => {
      const html = readFileSync(resolve(__dirname, '..', page), 'utf8');
      const m = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
      expect(m, `${page} missing <h1>`).not.toBeNull();
      expect(m![1].trim().length, `${page} <h1> is empty`).toBeGreaterThan(0);
    });
  }
});

describe('SEO — home JSON-LD enrichments', () => {
  // Parse the home @graph once for reuse.
  function loadGraph(): any[] {
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no JSON-LD on home');
    const data = JSON.parse(m[1].replace(/\\u003c/g, '<'));
    return data['@graph'] || [data];
  }

  it('WebSite carries a publisher Organization', () => {
    // Brand association + knowledge-panel eligibility.
    const site = loadGraph().find((n) => n['@type'] === 'WebSite');
    expect(site).toBeTruthy();
    expect(site.publisher).toBeTruthy();
    expect(site.publisher['@type']).toBe('Organization');
    expect(site.publisher.name).toBeTruthy();
    expect(site.publisher.url).toMatch(/^https:\/\//);
  });

  it('WebSite carries a SearchAction (eligible for sitelinks search box)', () => {
    const site = loadGraph().find((n) => n['@type'] === 'WebSite');
    expect(site.potentialAction).toBeTruthy();
    expect(site.potentialAction['@type']).toBe('SearchAction');
    expect(site.potentialAction.target.urlTemplate).toContain('{search_term_string}');
    expect(site.potentialAction['query-input']).toBe('required name=search_term_string');
  });

  it('Dataset count matches the number of visible level rows', () => {
    // Previously only LGD-sourced layers emitted JSON-LD — 8 of 10 visible
    // levels. Wildlife (GatiShakti) and eco-zones (Bharatmaps) were
    // invisible to Google Dataset Search. Now every visible row should
    // emit exactly one Dataset.
    const graph = loadGraph();
    const datasets = graph.filter((n) => n['@type'] === 'Dataset');
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    const visibleRows = (html.match(/<section class="row row--curated"/g) || []).length;
    expect(datasets.length).toBe(visibleRows);
    expect(datasets.length).toBeGreaterThanOrEqual(10);
  });

  it('every Dataset has a license URL + at least one DataDownload', () => {
    const datasets = loadGraph().filter((n) => n['@type'] === 'Dataset');
    for (const d of datasets) {
      expect(d.license, `${d.name} missing license`).toMatch(/^https:\/\//);
      expect(d.distribution?.length, `${d.name} no distribution`).toBeGreaterThan(0);
    }
  });
});
