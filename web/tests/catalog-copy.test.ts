import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Every text in catalog.json (layer notes, level labels and descriptions) is
// shown on cards, /layers and /view pages, and returned by the API and MCP:
// user copy, so it follows the site's punctuation (no em-dashes).
const catalog = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'catalog.json'), 'utf8'));

function* strings(o: unknown, path: string): Generator<string> {
  if (typeof o === 'string') { if (o.includes('—')) yield path; return; }
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) yield* strings(v, path ? `${path}.${k}` : k);
}

describe('catalog.json text', () => {
  it('uses commas, colons, periods or parentheses, never an em-dash', () => {
    expect([...strings(catalog, '')]).toEqual([]);
  });
});
