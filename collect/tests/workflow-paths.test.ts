// collect's workflow runs only when its watched paths change. collect also
// imports some of web/'s files, so a change there must rerun collect's tests
// and deploy too.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';

const repo = resolve(__dirname, '../..');
const workflow = readFileSync(join(repo, '.github/workflows/collect.yml'), 'utf8');
/** The `paths:` list under an `on:` event (a YAML block list of quoted paths). */
const watched = (key: 'push' | 'pull_request') => {
  const block = workflow.split(`\n  ${key}:\n`)[1]?.split(/\n  \S/)[0] ?? '';
  return [...block.matchAll(/^\s+- '([^']+)'/gm)].map((m) => m[1]);
};
const covers = (globs: string[], file: string) =>
  globs.some((g) => (g.endsWith('/**') ? file.startsWith(g.slice(0, -2)) : file === g));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === 'node_modules' || n === 'dist') return [];
    return statSync(p).isDirectory() ? files(p) : /\.(ts|mjs|js)$/.test(n) ? [p] : [];
  });
}

const importsOf = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)].map((m) => resolve(dirname(file), m[1]));
const asFile = (p: string) => [p, `${p}.ts`, `${p}.mjs`, join(p, 'index.ts')].find((f) => existsSync(f) && statSync(f).isFile());

/** Every file outside collect/ that collect's code or tests import, directly or through another such file. */
const outside = new Set<string>();
const queue = ['src', 'functions', 'tests'].flatMap((d) => files(join(repo, 'collect', d))).flatMap(importsOf);
while (queue.length) {
  const f = asFile(queue.pop()!);
  const rel = f && relative(repo, f);
  if (!f || !rel || rel.startsWith('collect/') || rel.startsWith('..') || outside.has(rel)) continue;
  outside.add(rel);
  queue.push(...importsOf(f));
}

describe("collect's workflow triggers", () => {
  it('finds the web/ files collect imports (the check is looking)', () => {
    expect([...outside].some((p) => p.startsWith('web/'))).toBe(true);
  });
  for (const key of ['push', 'pull_request'] as const) {
    it(`${key}: watches every file outside collect/ that collect imports`, () => {
      const missing = [...outside].filter((p) => !covers(watched(key), p));
      expect(missing).toEqual([]);
    });
  }
});
