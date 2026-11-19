// The /c/<id> map pages are served by a Function (it returns the c.html asset).
// _headers matches the path of the asset fetched (/c.html), not the page's own
// /c/* path, so the page's noindex header has to come from the Function. Checked
// locally with `wrangler pages dev`: CSP and the /* headers arrive, X-Robots-Tag
// did not.
import { describe, it, expect } from 'vitest';
import { onRequest } from '../../functions/c/[[path]]';

const CSP = "default-src 'self'";

async function serve(path: string): Promise<{ res: Response; fetched: string[] }> {
  const fetched: string[] = [];
  const ASSETS = {
    fetch: async (u: URL | string) => {
      fetched.push(String(u));
      return new Response('<!doctype html><title>collect</title>', {
        status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': CSP, 'x-frame-options': 'DENY' },
      });
    },
  };
  const ctx = { request: new Request(`https://collect.test${path}`), env: { ASSETS } } as unknown as Parameters<typeof onRequest>[0];
  return { res: await onRequest(ctx), fetched };
}

describe('the /c/ map page shell', () => {
  it('serves c.html for any map path', async () => {
    const { res, fetched } = await serve('/c/abc123/view');
    expect(fetched).toEqual(['https://collect.test/c.html']);
    expect(await res.text()).toContain('<title>collect</title>');
  });
  it('keeps map pages out of search with an X-Robots-Tag: noindex header', async () => {
    const { res } = await serve('/c/abc123');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
  });
  it('keeps the security headers the asset came with', async () => {
    const { res } = await serve('/c/abc123/admin');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.status).toBe(200);
  });
  it('serves the map shell for record links too', async () => {
    const { res, fetched } = await serve('/c/abc123/r/rec456');
    expect(fetched).toEqual(['https://collect.test/c.html']);
    expect(res.status).toBe(200);
  });
  // An address under /c/ that can't be a map link is collect's 404, with a 404
  // status, not the map shell saying "this link doesn't open a map".
  it('answers 404 with the 404 page for an address that is not a map link', async () => {
    for (const path of ['/c/', '/c/ab', '/c/abc123/edit', '/c/abc123/r/', '/c/abc123/view/x']) {
      const { res, fetched } = await serve(path);
      expect(fetched).toEqual(['https://collect.test/404.html']);
      expect(res.status).toBe(404);
      expect(res.headers.get('x-robots-tag')).toBe('noindex');
    }
  });
});
