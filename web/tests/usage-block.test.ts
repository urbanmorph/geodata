// The usage block on /layers (and the home line): downloads always; API and
// MCP queries only once they pass API_SHOW_MIN, so a counter that started on
// 17 Nov 2026 doesn't read as "nobody uses the API". Numbers come from
// /api/v1/usage at build time; nothing new is stored.
import { describe, it, expect, vi } from 'vitest';
import { usageBlockHtml, homeUsageSuffix, fetchUsageTotals, API_SHOW_MIN } from '../scripts/usage-totals.mjs';

describe('usageBlockHtml', () => {
  it('shows downloads alone while API queries are under the threshold', () => {
    const html = usageBlockHtml({ downloads: 38001, api: 191, mcp: 5 });
    expect(html).toContain('38k');
    expect(html).toContain('downloads');
    expect(html).not.toMatch(/API|MCP/);
  });
  it('adds API queries (with the MCP share) once they pass the threshold', () => {
    const html = usageBlockHtml({ downloads: 38001, api: API_SHOW_MIN, mcp: 400 });
    expect(html).toMatch(/1\.4k<\/[a-z]+>\s*<[^>]+>API queries/);
    expect(html).toContain('400 via MCP');
    expect(html).toContain('since 17 Nov 2026');
  });
  it('renders nothing when there is nothing to show', () => {
    expect(usageBlockHtml({ downloads: 0, api: 0, mcp: 0 })).toBe('');
  });
  it('has no em-dashes', () => {
    expect(usageBlockHtml({ downloads: 5, api: 5000, mcp: 5 })).not.toContain('—');
  });
});

describe('homeUsageSuffix', () => {
  it('is empty under the threshold and " · N API queries" over it', () => {
    expect(homeUsageSuffix({ api: 191, mcp: 5 })).toBe('');
    expect(homeUsageSuffix({ api: 1200, mcp: 300 })).toContain('1.5k');
    expect(homeUsageSuffix({ api: 1200, mcp: 300 })).toContain('API queries');
  });
});

describe('fetchUsageTotals', () => {
  it('reads total.api and total.mcp, with a generic User-Agent', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ layers: {}, total: { downloads: 9, api: 12, mcp: 3 } })));
    expect(await fetchUsageTotals(fetchImpl as never)).toEqual({ api: 12, mcp: 3 });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('user-agent')).toBe('bharatlas-build/1.0');
  });
  it('returns null when the API is unreachable or answers an error', async () => {
    expect(await fetchUsageTotals((async () => { throw new Error('offline'); }) as never)).toBeNull();
    expect(await fetchUsageTotals((async () => new Response('x', { status: 500 })) as never)).toBeNull();
  });
});
