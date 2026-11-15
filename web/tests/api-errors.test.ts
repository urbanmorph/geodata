// The API says 400 only for the caller's mistakes (QueryInputError); a server
// fault such as a missing R2 object is a 500, not "your request was bad".
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { nearby } from '../functions/lib/nearby';
import { QueryInputError } from '../functions/lib/parquet-query';
import { onRequestGet as queryRoute } from '../functions/api/v1/layers/[id]/query';
import { onRequestGet as nearbyRoute } from '../functions/api/v1/nearby';

const catalog = { layers: [{ id: 'roads', level: 'roads', source: 'x', parquet: { url: 'https://pub.example/roads.parquet', bytes: 10 } }, { id: 'tilesonly', level: 't', source: 'x' }] };
const emptyR2 = { head: async () => null, get: async () => null };

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(catalog))));
});

describe('nearby input errors', () => {
  it('an unknown or parquet-less layer is the caller\'s mistake', async () => {
    await expect(nearby(12, 77, 5, 'nope', catalog as never, emptyR2 as never)).rejects.toBeInstanceOf(QueryInputError);
    await expect(nearby(12, 77, 5, 'tilesonly', catalog as never, emptyR2 as never)).rejects.toBeInstanceOf(QueryInputError);
  });
});

describe('routes map errors to status codes', () => {
  const ctx = (url: string, id?: string) => ({ request: new Request(url), params: { id }, env: { R2: emptyR2 } }) as never;

  it('query: a missing R2 object is a 500', async () => {
    const r = await queryRoute(ctx('https://b.test/api/v1/layers/roads/query', 'roads'));
    expect(r.status).toBe(500);
  });

  it('nearby: an unknown layer is a 400, a missing R2 object a 500', async () => {
    expect((await nearbyRoute(ctx('https://b.test/api/v1/nearby?lat=12&lng=77&layer=nope'))).status).toBe(400);
    expect((await nearbyRoute(ctx('https://b.test/api/v1/nearby?lat=12&lng=77&layer=roads'))).status).toBe(500);
  });
});
