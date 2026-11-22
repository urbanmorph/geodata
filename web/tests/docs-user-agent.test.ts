// The /docs User-Agent request matches the 18 Nov 2026 usage decision: the UA
// only sorts a call into a mode (website, API, MCP, crawler) and is never
// stored. The old promise ("warn you before a change and list you below")
// is gone, and examples carry no link. Same intent as openapi.test.ts.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const docs = readFileSync(resolve(__dirname, '../docs.template.html'), 'utf8');

describe('/docs User-Agent request', () => {
  it('asks for an app name and says what we do (and do not do) with it', () => {
    expect(docs).toContain('Please send a <code>User-Agent</code> that names your app (for example <code>my-app/1.0</code>). We read it only to tell apps, AI tools and crawlers apart, so our counts of how each mode is used stay honest. We don\'t store it, and we don\'t track who you are.');
  });
  it('drops the old promise and the link in examples', () => {
    expect(docs).not.toMatch(/warn you before a change/);
    expect(docs).not.toMatch(/list you below/);
    expect(docs).not.toMatch(/User-Agent: [^"<]*\(\+https?:/);
    expect(docs).toContain('-H "User-Agent: my-app/1.0"');
  });
});

describe('/docs no longer teaches the retiring counts endpoint (2026-11-22)', () => {
  it('its examples use /query with group_by instead', () => {
    const docs = readFileSync(resolve(__dirname, '..', 'docs.template.html'), 'utf8');
    expect(docs).not.toMatch(/curl [^\n]*\/layers\/[^/\s]+\/counts/);
    expect(docs).toMatch(/Retires on 22 December 2026/);
    expect(docs).toContain('curl https://bharatlas.com/api/v1/layers/wards_pcmc/query?group_by=zone');
  });
});
