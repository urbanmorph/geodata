import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Layer notes are shown on cards, /layers and /view pages, and returned by the
// API and MCP: user copy, so they follow the site's punctuation (no em-dashes).
const catalog = JSON.parse(readFileSync(resolve(__dirname, '..', '..', 'catalog.json'), 'utf8'));

describe('catalog.json layer notes', () => {
  it('use commas, colons, periods or parentheses, never an em-dash', () => {
    const withDash = (catalog.layers as Array<{ id: string; notes?: string }>)
      .filter((l) => (l.notes || '').includes('—'))
      .map((l) => l.id);
    expect(withDash).toEqual([]);
  });
});
