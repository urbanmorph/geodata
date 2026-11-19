// /releases and /releases/<dataset>: human pages in the site's chrome, built from
// web/public/releases/index.json at build time (vite.config.ts emits them).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { renderReleasesIndex, renderReleaseDataset, releasePages, displayTitle } from '../scripts/releases-page.mjs';

const INDEX = JSON.parse(readFileSync(resolve(__dirname, '../public/releases/index.json'), 'utf8'));
const visible = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');

const TWO = {
  latest: { cw: 'bharatlas-cw-2026.12', lgd_states: 'bharatlas-lgd_states-2026.12' },
  releases: [
    { code: 'bharatlas-lgd_states-2026.12', dataset: 'lgd_states', title: 'States, LGD', released: '2026-12-02',
      sha256: 'f'.repeat(64), pin: `bharatlas-lgd_states-2026.12+sha256:${'f'.repeat(64)}`,
      url: 'https://bharatlas.com/releases/bharatlas-lgd_states-2026.12/',
      w3id_proposed: 'https://w3id.org/bharatlas/lgd_states/2026.12',
      manifest: 'https://bharatlas.com/releases/bharatlas-lgd_states-2026.12/manifest.json', previous: null,
      files: [{ name: 'lgd_states.parquet', url: 'https://bharatlas.com/releases/bharatlas-lgd_states-2026.12/lgd_states.parquet',
        sha256: 'a'.repeat(64), bytes: 7878522, rows: 36, licence: 'CC0-1.0' },
      { name: 'lgd_states.geojson', url: 'https://bharatlas.com/releases/bharatlas-lgd_states-2026.12/lgd_states.geojson',
        sha256: 'b'.repeat(64), bytes: 100, rows: null, licence: 'CC0-1.0' }] },
    { code: 'bharatlas-cw-2026.12', dataset: 'cw', title: 'Census 2011 <-> LGD crosswalk', released: '2026-12-01',
      sha256: 'c'.repeat(64), pin: `bharatlas-cw-2026.12+sha256:${'c'.repeat(64)}`,
      url: 'https://bharatlas.com/releases/bharatlas-cw-2026.12/', w3id_proposed: 'https://w3id.org/bharatlas/cw/2026.12',
      manifest: 'https://bharatlas.com/releases/bharatlas-cw-2026.12/manifest.json', previous: 'bharatlas-cw-2026.11', files: [] },
    { code: 'bharatlas-cw-2026.11', dataset: 'cw', title: 'Census 2011 <-> LGD crosswalk', released: '2026-11-15',
      sha256: 'd'.repeat(64), pin: `bharatlas-cw-2026.11+sha256:${'d'.repeat(64)}`,
      url: 'https://bharatlas.com/releases/bharatlas-cw-2026.11/', w3id_proposed: 'https://w3id.org/bharatlas/cw/2026.11',
      manifest: 'https://bharatlas.com/releases/bharatlas-cw-2026.11/manifest.json', previous: null, files: [] },
  ],
};

describe('the /releases page', () => {
  const html = renderReleasesIndex(TWO, new Set(['lgd_states']));

  it('wears the site chrome, light and dark', () => {
    expect(html).toContain('class="site-header"');
    expect(html).toContain('class="site-footer"');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('<link rel="canonical" href="https://bharatlas.com/releases" />');
    expect(html).not.toContain('/src/install.ts');
  });

  it('lists each dataset with its newest release, linking to the dataset page', () => {
    expect(html).toContain('href="/releases/cw"');
    expect(html).toContain('href="/releases/lgd_states"');
    expect(visible(html)).toContain('bharatlas-cw-2026.12');
    expect(visible(html)).toContain('2 releases');
    expect(visible(html)).toContain('Census 2011 to LGD crosswalk');
  });

  it('keeps the site words: no "catalog" and no em-dash in what a reader sees', () => {
    expect(visible(html)).not.toMatch(/catalog/i);
    expect(visible(html)).not.toContain('—');
  });

  it('points machines at the JSON index', () => {
    expect(html).toContain('href="/releases/index.json"');
    expect(html).toContain('href="/api/v1/releases"');
  });
});

describe('a /releases/<dataset> page', () => {
  const html = renderReleaseDataset(TWO, 'lgd_states', new Set(['lgd_states']));

  it('shows each release with its code, date, pin, files and w3id address', () => {
    const text = visible(html);
    expect(text).toContain('bharatlas-lgd_states-2026.12');
    expect(text).toContain('2 Dec 2026');
    expect(text).toContain(`bharatlas-lgd_states-2026.12+sha256:${'f'.repeat(64)}`);
    expect(html).toContain('href="https://w3id.org/bharatlas/lgd_states/2026.12"');
    expect(html).toContain('href="https://bharatlas.com/releases/bharatlas-lgd_states-2026.12/lgd_states.parquet"');
    expect(text).toContain('7.5 MB');
    expect(text).toContain('36 rows');
    expect(html).toContain('href="/releases/bharatlas-lgd_states-2026.12/manifest.json"');
    expect(html).toContain('href="/releases/bharatlas-lgd_states-2026.12/SHA256SUMS"');
  });

  it('links a layer dataset to its map and names the newest-release address', () => {
    expect(html).toContain('href="/view/lgd_states"');
    expect(html).toContain('/releases/lgd_states/latest');
  });

  it('lists only that dataset\'s releases, newest first, and says what came before', () => {
    const cw = renderReleaseDataset(TWO, 'cw', new Set());
    expect(cw.indexOf('bharatlas-cw-2026.12')).toBeLessThan(cw.indexOf('bharatlas-cw-2026.11'));
    expect(cw).not.toContain('lgd_states');
    expect(cw).not.toContain('href="/view/cw"');
    expect(cw).toContain('href="#bharatlas-cw-2026.11"');
  });

  it('keeps the site words and never shows a blank as an em-dash', () => {
    expect(visible(html)).not.toMatch(/catalog/i);
    expect(visible(html)).not.toContain('—');
  });
});

describe('releasePages', () => {
  it('builds /releases and one page per dataset from the real index', () => {
    const pages = releasePages(INDEX, new Set());
    const names = pages.map((p: { fileName: string }) => p.fileName).sort();
    expect(names).toEqual(['releases.html', ...Object.keys(INDEX.latest).map((d) => `releases/${d}.html`)].sort());
    for (const p of pages) expect(p.html).toMatch(/^<!doctype html>/);
  });
});

describe('displayTitle', () => {
  // A release title is immutable ("Census 2011 <-> LGD crosswalk"); pages show it in words so it
  // doesn't break as "<-" / "> LGD" on phones (owner, 2026-11-18).
  it('reads an arrow as words and leaves other titles alone', () => {
    expect(displayTitle('Census 2011 <-> LGD crosswalk')).toBe('Census 2011 to LGD crosswalk');
    expect(displayTitle('bharatlas record')).toBe('bharatlas record');
  });
});

describe('release pages: share card and structured data', () => {
  const ld = (html: string) => {
    const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('no JSON-LD');
    return JSON.parse(m[1].replace(/\\u003c/g, '<'))['@graph'];
  };

  it('carries the site share image, like every other page', () => {
    for (const html of [renderReleasesIndex(TWO), renderReleaseDataset(TWO, 'cw')]) {
      expect(html).toMatch(/<meta property="og:image" content="https:\/\/bharatlas\.com\/og-default\.png\?v=[0-9a-f]{10}" \/>/);
      expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    }
  });

  it('describes /releases as a collection page with a breadcrumb', () => {
    const graph = ld(renderReleasesIndex(TWO));
    const page = graph.find((n: any) => n['@type'] === 'CollectionPage');
    expect(page).toMatchObject({ name: 'Releases', url: 'https://bharatlas.com/releases' });
    expect(page.publisher.name).toBe('bharatlas');
    expect(graph.find((n: any) => n['@type'] === 'BreadcrumbList').itemListElement.map((i: any) => i.name)).toEqual(['Home', 'Releases']);
  });

  it('gives a dataset page a breadcrumb through /releases', () => {
    const graph = ld(renderReleaseDataset(TWO, 'cw'));
    const crumbs = graph.find((n: any) => n['@type'] === 'BreadcrumbList').itemListElement;
    expect(crumbs.map((i: any) => i.item)).toEqual(['https://bharatlas.com/', 'https://bharatlas.com/releases', 'https://bharatlas.com/releases/cw']);
    expect(crumbs[2].name).toBe('Census 2011 to LGD crosswalk');
  });
});
