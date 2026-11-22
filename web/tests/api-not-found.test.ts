import { describe, it, expect } from 'vitest';
import { notFoundForUnmatched, notFoundJson } from '../functions/lib/api-not-found';
import { apiError } from '../functions/lib/http';

describe('one JSON error shape', () => {
  it('apiError takes extra headers; notFoundJson is the shared 404 body', async () => {
    const r = apiError(503, 'Temporarily unavailable', { 'retry-after': '30' });
    expect(r.headers.get('retry-after')).toBe('30');
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(await r.text()).toBe('{"error":"Temporarily unavailable","status":503}');
    expect(await notFoundJson('/api/x').text()).toBe('{"error":"Not found: /api/x","status":404}');
  });
});

// Unknown /api paths fell through to the site's HTML page with a 200, so API
// clients and agents got a web page instead of an error (e.g. the removed
// /api/v1/hierarchy routes). No /api function returns HTML on purpose.
describe('notFoundForUnmatched', () => {
  it('turns an HTML fall-through into a JSON 404 naming the path', async () => {
    const html = new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const r = notFoundForUnmatched(html, '/api/v1/hierarchy/resolve');
    expect(r.status).toBe(404);
    expect(r.headers.get('content-type')).toBe('application/json');
    expect(await r.json()).toEqual({ error: 'Not found: /api/v1/hierarchy/resolve', status: 404 });
  });

  it('passes real API responses through untouched', () => {
    const ok = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(notFoundForUnmatched(ok, '/api/v1/levels')).toBe(ok);
    const redirect = new Response(null, { status: 302, headers: { location: 'https://r2/x.kml' } });
    expect(notFoundForUnmatched(redirect, '/api/dl/x.kml')).toBe(redirect);
  });
});
