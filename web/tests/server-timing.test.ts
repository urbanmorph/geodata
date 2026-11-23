// Where an API answer's time goes, in its server-timing header: the rate limit (the
// /api/v1 middleware), the handler's own phases (a point lookup's catalog, lookup and
// profile), and the whole /api middleware chain around them (api). A 1.5 to 2.5 s gap
// between a point lookup's total and its profile phase had to be told apart from the
// work before and after the handler.
import { describe, it, expect, beforeEach } from 'vitest';
import { onRequest as apiMiddleware } from '../functions/api/_middleware';
import { onRequest as v1Middleware } from '../functions/api/v1/_middleware';
import { __resetApiLimiterForTest } from '../functions/lib/api-ratelimit';
import { addTiming, timing } from '../functions/lib/server-timing';

beforeEach(() => __resetApiLimiterForTest());

const handler = (st?: string) => async () =>
  new Response('{}', { headers: { 'content-type': 'application/json', ...(st ? { 'server-timing': st } : {}) } });

describe('server-timing phases around the handler', () => {
  it('a phase is name;dur=ms, whole milliseconds', () => {
    expect(timing('limit', 0.4)).toBe('limit;dur=0');
    expect(timing('profile', 1234.6)).toBe('profile;dur=1235');
  });

  it('adds phases before and after the ones a response already has', () => {
    const h = new Headers({ 'server-timing': 'profile;dur=5' });
    addTiming(h, { before: ['limit;dur=1'], after: ['api;dur=9'] });
    expect(h.get('server-timing')).toBe('limit;dur=1, profile;dur=5, api;dur=9');
    const empty = new Headers();
    addTiming(empty, { after: ['api;dur=2'] });
    expect(empty.get('server-timing')).toBe('api;dur=2');
  });

  it('the /api/v1 middleware puts the rate limit first', async () => {
    const call = (st?: string) => v1Middleware({
      request: new Request('https://bharatlas.com/api/v1/ground?lat=1&lng=2', { headers: { 'cf-connecting-ip': '198.51.100.7' } }),
      env: { DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) }, IP_SALT: 's' },
      next: handler(st), waitUntil: () => {},
    } as never);
    expect((await call('catalog;dur=0, lookup;dur=2, profile;dur=400')).headers.get('server-timing'))
      .toMatch(/^limit;dur=\d+, catalog;dur=0, lookup;dur=2, profile;dur=400$/);
    expect((await call()).headers.get('server-timing')).toMatch(/^limit;dur=\d+$/);
  });

  it('the /api middleware adds the whole chain last', async () => {
    const r = await apiMiddleware({
      request: new Request('https://bharatlas.com/api/v1/ground?lat=1&lng=2'), env: {}, params: {}, data: {},
      next: handler('limit;dur=0, profile;dur=5'), waitUntil() {}, passThroughOnException() {}, functionPath: '',
    } as never);
    expect(r.headers.get('server-timing')).toMatch(/^limit;dur=0, profile;dur=5, api;dur=\d+$/);
  });
});
