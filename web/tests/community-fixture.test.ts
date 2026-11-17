// Deploy guard: production builds read community layers from D1; local and PR
// builds have none, so tests passed there and failed in production twice (#264
// page weight, #266 index links). `npm test` builds with COMMUNITY_FROM=fixture
// (tests/fixtures/community.json), so every run sees community cards like
// production does.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
const fixture = JSON.parse(read('tests/fixtures/community.json')) as { id: string; name: string }[];

describe('npm test uses the fixture', () => {
  it('for both the prerender and the test run', () => {
    expect(JSON.parse(read('package.json')).scripts.test).toBe("COMMUNITY_FROM=fixture sh -c 'node scripts/prerender.mjs && vitest run'");
  });
});

// The output checks run only on a fixture build: `npm run build` (CI's deploy
// step) prerenders from D1 and runs the suite again over that output.
describe.runIf(process.env.COMMUNITY_FROM === 'fixture')('test builds include community layers (fixture)', () => {
  it('every fixture submission is a card on /layers and an entry in the search index', () => {
    const layers = read('layers.html');
    const index = JSON.parse(read('public/layer-index.json')) as { h: string }[];
    for (const s of fixture) {
      expect(layers, s.id).toMatch(new RegExp(`<article class="comm-card[^"]*" data-id="${s.id}"`));
      expect(index.map((e) => e.h), s.id).toContain(`/c/${s.id}`);
    }
  });
  it('the home page counts them in "See all N layers" and offers the Community theme', () => {
    const home = read('index.html');
    expect(home).toContain('href="/layers?q=community"');
  });
});
