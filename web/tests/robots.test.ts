import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROBOTS } from '../functions/robots.txt';

// functions/robots.txt.ts is what crawlers get (it beats Cloudflare's managed
// robots); public/robots.txt is the static fallback. They must say the same.
const fallback = readFileSync(resolve(__dirname, '../public/robots.txt'), 'utf8');
const directives = (s: string) => s.split('\n').filter((l) => l && !l.startsWith('#'));
const header = (s: string) => s.split('\n\n')[0];

describe('robots.txt', () => {
  it('serves the same directives as the static fallback', () => {
    expect(directives(ROBOTS)).toEqual(directives(fallback));
  });

  it('opens with the same licence statement, without em-dashes or a blanket licence claim', () => {
    for (const s of [ROBOTS, fallback]) {
      expect(s).not.toContain('—');
      expect(s).not.toMatch(/CC0\/CC-BY/);
      expect(header(s)).toMatch(/each layer keeps its own open\s+(#\s+)?licence/i);
    }
    expect(header(ROBOTS)).toBe(header(fallback));
  });
});
