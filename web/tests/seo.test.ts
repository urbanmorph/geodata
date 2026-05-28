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
    // The compact-layout sections carry `row--compact` as an extra class.
    // Match anything starting with "row row--curated" until the class
    // attribute's closing quote.
    const visibleRows = (html.match(/<section class="row row--curated[^"]*"/g) || []).length;
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

  it('every Dataset description is ≥50 chars (Google Dataset Search rule)', () => {
    // Google Search Console rejects Dataset entries with shorter descriptions
    // ("Invalid string length in field 'description'"). The prerender pads
    // short notes via padDatasetDescription(); this test ensures the pad
    // actually fired on every emitted row, including future additions where
    // someone forgets to write a long description.
    const datasets = loadGraph().filter((n) => n['@type'] === 'Dataset');
    for (const d of datasets) {
      expect(
        d.description?.length ?? 0,
        `${d.name}: description too short (${d.description?.length} chars): "${d.description}"`,
      ).toBeGreaterThanOrEqual(50);
    }
  });
});

describe('SEO — /about FAQPage', () => {
  function loadAboutGraph(): any[] {
    const html = readFileSync(resolve(__dirname, '..', 'about.html'), 'utf8');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no JSON-LD on /about');
    const data = JSON.parse(m[1].replace(/\\u003c/g, '<'));
    return data['@graph'] || [data];
  }

  it('/about emits a FAQPage with ≥5 questions', () => {
    // AEO win: FAQ-shaped JSON-LD is what LLM crawlers (ChatGPT, Claude,
    // Perplexity) preferentially ingest for Q&A surfacing. Google can
    // also feature it in FAQ rich results.
    const graph = loadAboutGraph();
    const faq = graph.find((n) => n['@type'] === 'FAQPage');
    expect(faq, '/about missing FAQPage').toBeTruthy();
    expect(faq.mainEntity?.length, 'FAQPage needs ≥5 questions').toBeGreaterThanOrEqual(5);
    for (const q of faq.mainEntity) {
      expect(q['@type']).toBe('Question');
      expect(q.name?.length, 'Question name empty').toBeGreaterThan(5);
      expect(q.acceptedAnswer?.['@type']).toBe('Answer');
      expect(q.acceptedAnswer?.text?.length, 'Answer text empty').toBeGreaterThan(20);
    }
  });

  it('/about still emits an AboutPage', () => {
    // Don't lose the AboutPage type when adding FAQPage.
    const graph = loadAboutGraph();
    expect(graph.find((n) => n['@type'] === 'AboutPage'), '/about missing AboutPage').toBeTruthy();
  });

  it('/about has a visible <h2>Frequently asked</h2> section', () => {
    // FAQ surface for users, not just crawlers. Don't ship JSON-LD that
    // doesn't reflect what's on the page (Google has been known to
    // penalise FAQ markup without matching visible content).
    const html = readFileSync(resolve(__dirname, '..', 'about.html'), 'utf8');
    expect(html).toMatch(/<h2[^>]*>\s*Frequently asked\s*<\/h2>/i);
  });
});

describe('SEO — /mcp FAQPage + structured-data', () => {
  function loadMcpGraph(): any[] {
    const html = readFileSync(resolve(__dirname, '..', 'mcp.html'), 'utf8');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no JSON-LD on /mcp');
    const data = JSON.parse(m[1].replace(/\\u003c/g, '<'));
    return data['@graph'] || [data];
  }

  it('/mcp emits a FAQPage with ≥8 questions', () => {
    // The page already shows 11 visible <p class="question">…</p> /
    // <p class="answer">…</p> pairs under "What you can ask". Mirroring
    // them as FAQPage JSON-LD lights up Google rich results AND gives
    // LLM crawlers (ChatGPT/Claude/Perplexity) a clean Q&A ingest.
    const faq = loadMcpGraph().find((n) => n['@type'] === 'FAQPage');
    expect(faq, '/mcp missing FAQPage').toBeTruthy();
    expect(faq.mainEntity?.length, 'FAQPage needs ≥8 questions').toBeGreaterThanOrEqual(8);
    for (const q of faq.mainEntity) {
      expect(q['@type']).toBe('Question');
      expect(q.acceptedAnswer?.['@type']).toBe('Answer');
      expect(q.acceptedAnswer?.text?.length, 'Answer empty').toBeGreaterThan(20);
    }
  });

  it('/mcp still emits SoftwareApplication', () => {
    expect(loadMcpGraph().find((n) => n['@type'] === 'SoftwareApplication'), 'lost SoftwareApplication')
      .toBeTruthy();
  });
});

describe('SEO — /docs FAQPage + structured-data', () => {
  function loadDocsGraph(): any[] {
    const html = readFileSync(resolve(__dirname, '..', 'docs.html'), 'utf8');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no JSON-LD on /docs');
    const data = JSON.parse(m[1].replace(/\\u003c/g, '<'));
    return data['@graph'] || [data];
  }

  it('/docs emits a FAQPage with ≥4 questions', () => {
    const faq = loadDocsGraph().find((n) => n['@type'] === 'FAQPage');
    expect(faq, '/docs missing FAQPage').toBeTruthy();
    expect(faq.mainEntity?.length, 'FAQPage needs ≥4 questions').toBeGreaterThanOrEqual(4);
    for (const q of faq.mainEntity) {
      expect(q['@type']).toBe('Question');
      expect(q.acceptedAnswer?.['@type']).toBe('Answer');
      expect(q.acceptedAnswer?.text?.length, 'Answer empty').toBeGreaterThan(20);
    }
  });

  it('/docs still emits WebAPI', () => {
    expect(loadDocsGraph().find((n) => n['@type'] === 'WebAPI'), 'lost WebAPI').toBeTruthy();
  });

  it('/docs has a visible Common questions section (Google needs visible Q&A to match FAQPage markup)', () => {
    const html = readFileSync(resolve(__dirname, '..', 'docs.html'), 'utf8');
    expect(html).toMatch(/<h2[^>]*>\s*Common questions\s*<\/h2>/i);
  });
});

describe('SEO — BreadcrumbList on every prerendered page', () => {
  // Breadcrumbs reinforce site structure for Google (sitelinks breadcrumb
  // trail in SERPs) and give LLM crawlers a navigable hierarchy.
  const PAGES = [
    { file: 'index.html', last: 'Catalog' },
    { file: 'about.html', last: 'About' },
    { file: 'preview.html', last: 'Preview' },
    { file: 'docs.html', last: 'API v1' },
    { file: 'mcp.html', last: 'MCP Server' },
    { file: 'privacy.html', last: 'Privacy' },
    { file: 'terms.html', last: 'Terms' },
  ];

  for (const { file, last } of PAGES) {
    it(`${file} emits a BreadcrumbList ending in "${last}"`, () => {
      const html = readFileSync(resolve(__dirname, '..', file), 'utf8');
      const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(m, `${file} no JSON-LD`).not.toBeNull();
      const data = JSON.parse(m![1].replace(/\\u003c/g, '<'));
      const graph = data['@graph'] || [data];
      const bc = graph.find((n: any) => n['@type'] === 'BreadcrumbList');
      expect(bc, `${file} missing BreadcrumbList`).toBeTruthy();
      expect(bc.itemListElement?.length, 'breadcrumb needs ≥2 items').toBeGreaterThanOrEqual(2);
      const tail = bc.itemListElement[bc.itemListElement.length - 1];
      expect(tail.name).toBe(last);
    });
  }
});

describe('SEO — legal pages carry WebPage JSON-LD', () => {
  // /privacy and /terms were shipping zero structured data. WebPage with
  // isPartOf reinforces they belong to the bharatlas WebSite, lifting
  // entity association in Google's knowledge graph.
  for (const file of ['privacy.html', 'terms.html']) {
    it(`${file} emits a WebPage with isPartOf the bharatlas WebSite`, () => {
      const html = readFileSync(resolve(__dirname, '..', file), 'utf8');
      const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      expect(m, `${file} no JSON-LD`).not.toBeNull();
      const data = JSON.parse(m![1].replace(/\\u003c/g, '<'));
      const graph = data['@graph'] || [data];
      const wp = graph.find((n: any) => n['@type'] === 'WebPage');
      expect(wp, `${file} missing WebPage`).toBeTruthy();
      expect(wp.isPartOf?.['@type']).toBe('WebSite');
      expect(wp.isPartOf?.url).toMatch(/^https:\/\/bharatlas\.com/);
    });
  }
});

describe('SEO — /about Person.sameAs includes GitHub for entity disambiguation', () => {
  it('/about Person sameAs contains both linkedin and github', () => {
    const html = readFileSync(resolve(__dirname, '..', 'about.html'), 'utf8');
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const data = JSON.parse(m![1].replace(/\\u003c/g, '<'));
    const graph = data['@graph'] || [data];
    const person = graph.find((n: any) => n['@type'] === 'Person');
    expect(person?.sameAs).toEqual(expect.arrayContaining([
      expect.stringMatching(/linkedin\.com/),
      expect.stringMatching(/github\.com/),
    ]));
  });
});

describe('SEO — OG image dimensions on prerendered pages', () => {
  // Twitter/Slack/iMessage cards render correctly without dims, but Facebook
  // and LinkedIn need explicit width/height to skip a re-fetch + show the
  // card on first scrape. All bharatlas OG cards are 1200×630.
  const PAGES = ['index.html', 'about.html', 'preview.html', 'docs.html', 'mcp.html', 'privacy.html', 'terms.html'];

  for (const page of PAGES) {
    it(`${page} declares og:image:width=1200 and og:image:height=630`, () => {
      const html = readFileSync(resolve(__dirname, '..', page), 'utf8');
      expect(html, `${page} missing og:image:width`).toMatch(/property="og:image:width" content="1200"/);
      expect(html, `${page} missing og:image:height`).toMatch(/property="og:image:height" content="630"/);
    });
  }
});

describe('SEO — per-page OG images differentiated', () => {
  function og(page: string): string {
    const html = readFileSync(resolve(__dirname, '..', page), 'utf8');
    const m = html.match(/property="og:image" content="([^"]+)"/);
    return m ? m[1] : '';
  }

  it('home uses og-default.png', () => {
    expect(og('index.html')).toMatch(/\/og-default\.png$/);
  });

  it('/about uses og-about.png', () => {
    expect(og('about.html')).toMatch(/\/og-about\.png$/);
  });

  it('/preview uses og-preview.png', () => {
    expect(og('preview.html')).toMatch(/\/og-preview\.png$/);
  });

  it('every page also sets twitter:image (mirror of og:image)', () => {
    for (const page of ['index.html', 'about.html', 'preview.html']) {
      const html = readFileSync(resolve(__dirname, '..', page), 'utf8');
      const ogM = html.match(/property="og:image" content="([^"]+)"/);
      const twM = html.match(/name="twitter:image" content="([^"]+)"/);
      expect(twM, `${page} no twitter:image`).not.toBeNull();
      expect(twM![1]).toBe(ogM![1]);
    }
  });
});
