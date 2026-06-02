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

  it('every Dataset declares isAccessibleForFree:true', () => {
    // Small but free Google Dataset Search signal — explicitly marking the
    // data as free helps rank vs paywalled alternates.
    const datasets = loadGraph().filter((n) => n['@type'] === 'Dataset');
    for (const d of datasets) {
      expect(d.isAccessibleForFree, `${d.name} missing isAccessibleForFree`).toBe(true);
    }
  });

  it('every Dataset has keywords (array, ≥3 items)', () => {
    // Google Dataset Search uses keywords for query matching.
    // We derive: [level, label, source, category, 'India'].
    const datasets = loadGraph().filter((n) => n['@type'] === 'Dataset');
    for (const d of datasets) {
      expect(Array.isArray(d.keywords), `${d.name} keywords not an array`).toBe(true);
      expect(d.keywords.length, `${d.name} too few keywords`).toBeGreaterThanOrEqual(3);
      expect(d.keywords).toContain('India');
    }
  });
});

describe('CLS regression guards (Web Vitals)', () => {
  // Two CLS sources fixed in the same PR:
  //   1. main.ts used to remove `.view-seo` on hydrate, shrinking the body
  //      on /view/<id> pages.
  //   2. `?q=…` URL params triggered apply() with forceExpand=true after
  //      first paint, expanding every section.
  // These tests pin the fixes so we don't reintroduce either silently.

  it("main.ts does NOT remove .view-seo on hydrate (body shift fix)", () => {
    const main = readFileSync(resolve(__dirname, '..', 'src', 'main.ts'), 'utf8');
    // The original line was `document.querySelector('.view-seo')?.remove();`.
    // It can stay in comments for context but must not execute.
    expect(main).not.toMatch(/^\s*document\.querySelector\(['"]\.view-seo['"]\)\?\.remove\(\);?\s*$/m);
  });

  it('q-precheck.js exists in public/ and adds .has-query for ?q=…', () => {
    const js = readFileSync(resolve(__dirname, '..', 'public', 'q-precheck.js'), 'utf8');
    expect(js).toMatch(/URLSearchParams/);
    expect(js).toMatch(/has-query/);
  });

  it("index.html loads q-precheck.js synchronously in <head> before any main script", () => {
    // index.html in web/ root is the prerender output (dev path `/src/main.ts`).
    // After `vite build`, dist/index.html has the hashed `/assets/main-XXX.js`.
    // Either way, q-precheck.js must be in <head> and precede every other script.
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    const head = html.match(/<head[^>]*>([\s\S]*?)<\/head>/)?.[1] ?? '';
    expect(head, 'q-precheck.js must be inside <head>').toContain('q-precheck.js');

    const precheckIdx = html.indexOf('q-precheck.js');
    // First "real" script tag (excludes <script type="application/ld+json">
    // and <script type="application/json"> data blobs).
    const firstScript = html.search(/<script(?![^>]+type="application\/)[^>]*src=/);
    expect(precheckIdx, 'q-precheck must precede every other script tag').toBeLessThan(firstScript);

    const tag = html.match(/<script[^>]*\/q-precheck\.js[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag![0]).not.toMatch(/\bdefer\b|\basync\b/);
  });

  it('CSS preempts the expand on html.has-query (no JS mutation needed)', () => {
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    expect(html).toMatch(/html\.has-query[^{]*\.row--collapsed\s*{[^}]*display:\s*block/);
  });
});

describe('Community cards have parity with curated rows (View + Download)', () => {
  // Community cards carry inline "View map" + Download. The targets depend on
  // whether the submission has been baked (scripts/bake_community.py):
  //   unbaked → /preview on the raw R2 file + a single raw download.
  //   baked   → /view/c_<id> (the full curated viewer, comm-card--baked class)
  //             + the curated multi-format /api/dl strip.
  // Both link to the same .btn-primary "View map" pill as curated rows.
  it('every comm-card has a "View map" link (baked → /view/c_<id>, else /preview)', () => {
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    const cards = html.match(/<article class="comm-card[^>]+>[\s\S]*?<\/article>/g) || [];
    if (cards.length === 0) return; // no community submissions yet — vacuous pass
    for (const card of cards) {
      const id = card.match(/data-id="([^"]+)"/)![1];
      if (/comm-card--baked/.test(card)) {
        expect(card, `baked comm-card ${id} → /view/c_<id>`).toMatch(
          new RegExp(`href="/view/c_${id}"`),
        );
      } else {
        expect(card, `comm-card ${id} missing /preview View link`).toMatch(
          /href="\/preview\?url=[^"]*%2Fapi%2Fr2%2Fcommunity%2F[^"]+"/,
        );
      }
      // Visual parity: same pill class as curated rows.
      expect(card, `comm-card ${id} uses .btn-primary View pill`).toMatch(/class="btn-primary comm-card__view"/);
      expect(card, `comm-card ${id} View map text`).toMatch(/View on map|View map/);
    }
  });

  it('every comm-card has inline downloads (baked → /api/dl multi-format, else single /api/r2)', () => {
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    const cards = html.match(/<article class="comm-card[^>]+>[\s\S]*?<\/article>/g) || [];
    if (cards.length === 0) return;
    for (const card of cards) {
      const id = card.match(/data-id="([^"]+)"/)![1];
      if (/comm-card--baked/.test(card)) {
        expect(card, `baked comm-card ${id} multi-format downloads`).toMatch(
          /href="\/api\/dl\/community\/[^"]+"/,
        );
      } else {
        expect(card, `comm-card ${id} missing inline Download link`).toMatch(
          /href="\/api\/r2\/community\/[^"]+"[^>]*download/,
        );
      }
    }
  });
});

describe('SEO/AEO — curated cards expose data vintage on the home grid', () => {
  // Every curated card SHOULD surface either a "fetched" or "vintage"
  // line so users (and AEO consumers) can judge freshness. Today only
  // the ~37 yashveer-republished layers carry fetched_at in catalog.json;
  // ramSeraph + own-baked + city-ward layers don't yet (older bake
  // scripts didn't set it). New layers MUST set it — see memory rule
  // "new-layers-need-fetched-at". Threshold reflects the honest state
  // and ratchets up as ingest scripts get the backfill.
  it('at least 25% of visible rows have a date string in the description', () => {
    const html = readFileSync(resolve(__dirname, '..', 'index.html'), 'utf8');
    const sections = html.match(/<section class="row row--curated[^>]+>[\s\S]*?<\/section>/g) || [];
    expect(sections.length).toBeGreaterThan(0);
    let withDate = 0;
    for (const sec of sections) {
      // Match the "Updated:" + ISO date pattern emitted by prerender,
      // tolerant of intervening HTML (the date is wrapped in <time>).
      if (/(updated|vintage|fetched)[\s\S]*?\d{4}-\d{2}-\d{2}/i.test(sec)) withDate++;
    }
    expect(withDate / sections.length).toBeGreaterThanOrEqual(0.25);
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
