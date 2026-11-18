// A layer id that was folded into another answers 301 to the new id, on the
// /view page and the API detail. _redirects can't do it: Pages Functions own
// /view/* and /api/*, and Functions win over _redirects.
import { describe, it, expect } from 'vitest';
import { retiredRedirect, RETIRED_LAYERS } from '../functions/lib/retired-layers';
import { onRequestGet as view } from '../functions/view/[id]';
import { onRequestGet as apiLayer } from '../functions/api/v1/layers/[id]';

const ctxFor = (path: string, id: string) => ({
  request: new Request(`https://bharatlas.com${path}?utm_source=x`),
  params: { id },
  env: { ASSETS: { fetch: async () => new Response('{}', { status: 404 }) } },
  waitUntil: () => {},
}) as never;

describe('retired layer ids', () => {
  it('ir_stations_merged now lives at ir_stations (owner, 2026-11-18)', () => {
    expect(RETIRED_LAYERS.ir_stations_merged).toBe('ir_stations');
  });
  it('retiredRedirect swaps the id segment, keeps the query, and ignores live ids', () => {
    const r = retiredRedirect(new URL('https://bharatlas.com/view/ir_stations_merged?q=1'), 'ir_stations_merged')!;
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('https://bharatlas.com/view/ir_stations?q=1');
    expect(retiredRedirect(new URL('https://bharatlas.com/view/ir_stations'), 'ir_stations')).toBeNull();
  });
  it('the /view page and the API detail redirect before looking the id up', async () => {
    const v = await view(ctxFor('/view/ir_stations_merged', 'ir_stations_merged'));
    expect(v.status).toBe(301);
    expect(v.headers.get('location')).toContain('/view/ir_stations?');
    const a = await apiLayer(ctxFor('/api/v1/layers/ir_stations_merged', 'ir_stations_merged'));
    expect(a.status).toBe(301);
    expect(a.headers.get('location')).toContain('/api/v1/layers/ir_stations?');
  });
});
