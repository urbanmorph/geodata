// Every edge 404 (unknown page, layer, submission) serves the themed page, and
// an unknown layer suggests the closest real ones.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../functions/lib/submissions', () => ({ getSubmissionForView: vi.fn(async () => null) }));
vi.mock('../functions/lib/ratings', () => ({ countVotes: vi.fn(async () => ({ up: 0, down: 0 })) }));

import { __resetCatalogForTest } from '../functions/lib/catalog-loader';
import { __resetNotFoundForTest } from '../functions/lib/not-found';
import { onRequest as middleware } from '../functions/_middleware';
import { onRequestGet as viewRoute } from '../functions/view/[id]';
import { onRequestGet as cRoute } from '../functions/c/[id]';
// @ts-expect-error: plain .mjs
import { renderNotFoundPage } from '../scripts/not-found-page.mjs';

const SHELL: string = renderNotFoundPage();
const CATALOG = {
  layers: [
    { id: 'lgd_districts', level: 'district', source: 'LGD', rows: 1 },
    { id: 'soi_districts', level: 'district', source: 'SOI', rows: 1 },
    { id: 'wards_pune', level: 'wards_pune', source: 'PMC', rows: 1 },
  ],
};
const assets = {
  fetch: vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/catalog.json') return new Response(JSON.stringify(CATALOG));
    if (path === '/404.html') return new Response(SHELL, { status: 404 });
    return new Response('nf', { status: 404 });
  }),
};

async function call(handler: (ctx: never) => Promise<Response>, path: string, params: Record<string, string> = {}) {
  return handler({
    request: new Request(`https://bharatlas.com${path}`),
    env: { ASSETS: assets, DB: {} },
    params,
    next: async () => new Response('next'),
    waitUntil: () => {},
  } as never);
}

beforeEach(() => {
  __resetCatalogForTest();
  __resetNotFoundForTest();
});

describe('edge 404s use the themed page', () => {
  it('an unknown page', async () => {
    const r = await call(middleware, '/no-such-page');
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain('class="site-header"');
    expect(html).toContain('Page not found');
  });

  it('a known page passes through', async () => {
    expect(await (await call(middleware, '/layers')).text()).toBe('next');
  });

  it('an unknown submission', async () => {
    const r = await call(cRoute, '/c/nope', { id: 'nope' });
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain('class="site-header"');
    expect(html).toContain('Submission not found');
  });

  it('an unknown layer suggests the closest layers, as View links', async () => {
    const r = await call(viewRoute, '/view/lgd_district', { id: 'lgd_district' });
    expect(r.status).toBe(404);
    const html = await r.text();
    expect(html).toContain('Layer not found');
    expect(html).toContain('Did you mean');
    expect(html).toMatch(/<a href="\/view\/lgd_districts">View [^<]+<\/a>/);
    expect(html.indexOf('/view/lgd_districts')).toBeLessThan(html.indexOf('/view/soi_districts'));
    expect(html).not.toContain('/view/wards_pune');
    const visible = html.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ');
    expect(visible).not.toMatch(/catalog/i);
  });

  it('an unknown layer with nothing close has no suggestions', async () => {
    const html = await (await call(viewRoute, '/view/zzzzqqqq', { id: 'zzzzqqqq' })).text();
    expect(html).toContain('Layer not found');
    expect(html).not.toContain('Did you mean');
  });
});
