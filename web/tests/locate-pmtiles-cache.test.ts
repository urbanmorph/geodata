// /api/v1/locate reads 13+ layers per request. One header and directory cache per R2 key
// per isolate keeps each archive's directory warm instead of re-reading it from R2 on
// every request (each call still gets its own reader: profile-endpoint.test.ts).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pmtilesFor } from '../functions/lib/locate';
import { fakeR2 } from './helpers/fake-r2';

describe('pmtilesFor', () => {
  it('keeps one header and directory cache per key: a second reader of the archive reads nothing again', async () => {
    const key = 'wards/a.pmtiles';
    const gets: Array<[string, number, number]> = [];
    const r2 = fakeR2({ [key]: readFileSync(new URL('./fixtures/nearby-lines.pmtiles', import.meta.url)) }, gets);
    const first = await pmtilesFor(r2, key).getHeader();
    const n = gets.length;
    expect(await pmtilesFor(r2, key).getHeader()).toEqual(first);
    expect(gets.length).toBe(n);
    await pmtilesFor(r2, 'wards/b.pmtiles').getHeader().catch(() => {}); // another key: its own cache, its own read
  });
});
