// Visible copy uses commas, colons, periods and parentheses, never an em-dash
// (owner style rule). Comments may keep theirs: only string literals count.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const web = resolve(__dirname, '..');
const files = [
  ...readdirSync(resolve(web, 'src')).filter((f) => /\.(ts|mjs)$/.test(f)).map((f) => `src/${f}`),
  'functions/lib/render-view.ts',
  'functions/lib/view-dataset.ts',
  'functions/lib/licenses.ts',
  'functions/lib/nearby.ts',
  'functions/api/submit.ts',
];

/** The code with comments removed, so only strings and code remain. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');

describe('no em-dash in visible strings', () => {
  for (const f of files) {
    it(f, () => {
      const hits = code(readFileSync(resolve(web, f), 'utf8')).split('\n').filter((l) => l.includes('—'));
      expect(hits).toEqual([]);
    });
  }
});
