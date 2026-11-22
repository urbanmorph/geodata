// The point lookups are released (2026-11-22): the runtime flag (wrangler.toml [vars],
// read by functions/lib/point-profiles.ts) and the build flag (CI's build env, read by
// prerender for the docs, FAQ and credits) must both say "on", or the API and its docs disagree.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('point profiles are released', () => {
  it('the Pages runtime has POINT_PROFILES = "on"', () => {
    const vars = read('../wrangler.toml').split(/^\[vars\]$/m)[1].split(/^\[/m)[0];
    expect(vars).toMatch(/^POINT_PROFILES = "on"$/m);
  });

  it('the deploy build sets POINT_PROFILES: on', () => {
    const build = read('../../.github/workflows/ci.yml').split('- name: build')[1].split('- name:')[0];
    expect(build).toMatch(/^\s+POINT_PROFILES: on$/m);
  });
});
