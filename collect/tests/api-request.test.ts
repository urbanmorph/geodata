// @vitest-environment happy-dom
// api(): the one fetch to collect's API. A JSON body is sent as JSON unless the
// caller names its own content-type (a photo upload sends image/jpeg).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api';
import { uploadPhoto } from '../src/send-queue';

type Call = { url: string; headers: Headers; body: unknown; method?: string };
function stubFetch(reply: () => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers), body: init.body, method: init.method });
    return reply();
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('sends a body as JSON with the bearer token', async () => {
    const calls = stubFetch(() => new Response('{}'));
    await api('/collections/abc123/records', 'edt_x', { method: 'POST', body: '{}' });
    expect(calls[0].url).toBe('/api/collect/v1/collections/abc123/records');
    expect(calls[0].headers.get('content-type')).toBe('application/json');
    expect(calls[0].headers.get('authorization')).toBe('Bearer edt_x');
  });

  it('keeps a content-type the caller set', async () => {
    const calls = stubFetch(() => new Response('{}'));
    await api('/x', 'edt_x', { method: 'POST', body: new Uint8Array([1]), headers: { 'content-type': 'image/jpeg' } });
    expect(calls[0].headers.get('content-type')).toBe('image/jpeg');
  });
});

describe('uploadPhoto', () => {
  const photo = { client_id: 'photo-client-0000001', bytes: new Uint8Array([0xff, 0xd8]), meta: { lat: 12.9 } } as unknown as Parameters<typeof uploadPhoto>[2];

  it('posts the raw JPEG with its client id and meta headers', async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ id: 'ph_abcdefghij' })));
    expect(await uploadPhoto('abc123', 'edt_x', photo)).toEqual({ ok: true, id: 'ph_abcdefghij' });
    const c = calls[0];
    expect([c.url, c.method]).toEqual(['/api/collect/v1/collections/abc123/photos', 'POST']);
    expect(c.headers.get('content-type')).toBe('image/jpeg');
    expect(c.headers.get('authorization')).toBe('Bearer edt_x');
    expect(c.headers.get('x-client-id')).toBe('photo-client-0000001');
    expect(JSON.parse(c.headers.get('x-photo-meta')!)).toEqual({ lat: 12.9 });
    expect(c.body).toBe(photo.bytes);
  });

  it('says a turned-off link plainly, and no connection when fetch fails', async () => {
    stubFetch(() => new Response('{"error":"unauthorised"}', { status: 401 }));
    expect(await uploadPhoto('abc123', 'edt_x', photo)).toMatchObject({ ok: false, status: 401, error: expect.stringMatching(/no longer works/) });
    vi.stubGlobal('fetch', async () => { throw new TypeError('offline'); });
    expect(await uploadPhoto('abc123', 'edt_x', photo)).toEqual({ ok: false, status: 0, error: 'no connection' });
  });
});
