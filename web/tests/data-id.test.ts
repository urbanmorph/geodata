// dist/data-id.txt: a hash of every baked file the API answers from (web/public/api-data/),
// so answer cache keys move when the data does and stay when only code is deployed.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dataId } from '../scripts/data-id.mjs';

describe('dataId', () => {
  const tree = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'data-id-'));
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dir, p, '..'), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    return dir;
  };
  it('the same files give the same id, whatever order they are listed in', () => {
    expect(dataId(tree({ 'a/x.json': '1', 'b/y.json': '2' }))).toBe(dataId(tree({ 'b/y.json': '2', 'a/x.json': '1' })));
  });
  it('a changed, added or renamed file gives another', () => {
    const base = dataId(tree({ 'a/x.json': '1' }));
    expect(dataId(tree({ 'a/x.json': '2' }))).not.toBe(base);
    expect(dataId(tree({ 'a/x.json': '1', 'a/z.json': '' }))).not.toBe(base);
    expect(dataId(tree({ 'a/w.json': '1' }))).not.toBe(base);
  });
  it('a missing folder is an empty id, not a crash', () => {
    expect(dataId(join(tmpdir(), 'no-such-dir-data-id'))).toMatch(/^[0-9a-f]{16}$/);
  });
});
