// MCP clients (Claude Code) open GET /mcp with Accept: text/event-stream to ask for a
// server-sent event stream. The Streamable HTTP spec: answer with a stream, or 405 when
// the server offers none. GET /mcp fell through to the HTML page that explains the
// server, so clients got a 200 web page, and during a deploy switchover a 500 (four
// on 24 Nov 2026, 08:25 UTC). A browser still gets the page.
import { describe, it, expect } from 'vitest';
import { onRequestGet } from '../functions/mcp';

const call = (accept: string) => {
  let nexted = false;
  const ctx = {
    request: new Request('https://bharatlas.com/mcp', { headers: { accept } }),
    next: async () => { nexted = true; return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }); },
  };
  return Promise.resolve((onRequestGet as unknown as (c: typeof ctx) => Response | Promise<Response>)(ctx)).then((res) => ({ res, nexted }));
};

describe('GET /mcp', () => {
  it('an MCP client asking for an event stream gets 405, allowing POST', async () => {
    const { res, nexted } = await call('text/event-stream');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, OPTIONS');
    expect(nexted).toBe(false);
  });
  it('a browser gets the page that explains the server', async () => {
    const { res, nexted } = await call('text/html,application/xhtml+xml,*/*;q=0.8');
    expect(res.status).toBe(200);
    expect(nexted).toBe(true);
  });
});
