// A parquet is read as many range reads: its footer (often from the colo's cache or
// this isolate's), then row groups. If the object were overwritten under the same key
// between them, the rows would come from another upload than the footer describes: wrong
// answers, silently. Every range read is pinned to the etag the footer came with; a
// mismatch is an error (never mixed bytes), and this isolate forgets the object so the
// next request reads it afresh. (Policy is to never overwrite R2 keys; this is the guard.)
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { asyncBufferFromR2, openParquet, clearHeadCache, clearMetadataCache, StaleObjectError } from '../functions/lib/parquet-r2';
import { fakeR2 } from './helpers/fake-r2';
import { coloBucket, coloCache } from '../functions/lib/colo-cache';
import { queryFailure } from '../functions/lib/parquet-query';
import type { EdgeCache } from '../functions/lib/edge-cache';

function memoryCache(): EdgeCache {
  const store = new Map<string, Response>();
  return { async match(k) { return store.get(String(k))?.clone(); }, async put(k, r) { store.set(String(k), r); } };
}

const A = readFileSync(new URL('./fixtures/value-index.parquet', import.meta.url));
const B = readFileSync(new URL('./fixtures/nearby-points-rounded.parquet', import.meta.url));

beforeEach(() => { clearHeadCache(); clearMetadataCache(); });

describe('range reads are pinned to the object the footer came from', () => {
  it('an overwrite between the footer and a row read is an error, not the other upload\'s bytes', async () => {
    const objects: Record<string, Buffer> = { 't/x.parquet': A };
    const r2 = fakeR2(objects);
    const { file } = await openParquet(r2, 't/x.parquet', 16);
    objects['t/x.parquet'] = B; // overwritten
    await expect(file.slice(0, 4)).rejects.toBeInstanceOf(StaleObjectError);
  });

  it('the same for a file opened by its head, and for a stream', async () => {
    const objects: Record<string, Buffer> = { 't/x.parquet': A };
    const file = await asyncBufferFromR2(fakeR2(objects), 't/x.parquet');
    objects['t/x.parquet'] = B;
    await expect(file.slice(0, 4)).rejects.toBeInstanceOf(StaleObjectError);
    const it = file.stream!(0, 4)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toBeInstanceOf(StaleObjectError);
  });

  it('after a stale read the isolate forgets the object: the next open reads the new one', async () => {
    const objects: Record<string, Buffer> = { 't/x.parquet': A };
    const r2 = fakeR2(objects);
    const first = await openParquet(r2, 't/x.parquet', 16);
    objects['t/x.parquet'] = B;
    await expect(first.file.slice(0, 4)).rejects.toBeInstanceOf(StaleObjectError);
    const again = await openParquet(r2, 't/x.parquet', 16);
    expect(again.file.byteLength).toBe(B.byteLength);
    expect(new Uint8Array(await again.file.slice(0, 4))).toEqual(new Uint8Array(B.subarray(0, 4)));
  });

  it('an unchanged object reads as before', async () => {
    const { file } = await openParquet(fakeR2({ 't/x.parquet': A }), 't/x.parquet', 16);
    expect(new Uint8Array(await file.slice(0, 4))).toEqual(new Uint8Array(A.subarray(0, 4)));
  });
});

describe('through the colo\'s cache', () => {
  it('a footer kept in the colo from before an overwrite is not used again once a read finds the object changed', async () => {
    const objects: Record<string, Buffer> = { 't/y.parquet': A };
    const cache = memoryCache();
    const open = async () => {
      const waits: Promise<unknown>[] = [];
      const colo = coloCache(cache, (p) => waits.push(p));
      const r2 = coloBucket(fakeR2(objects), colo, 'v1');
      const opened = await openParquet(r2, 't/y.parquet', 16);
      colo.startPuts();
      await Promise.all(waits);
      return opened;
    };
    await open(); // the footer is now in the colo
    clearHeadCache(); clearMetadataCache(); // a fresh isolate
    objects['t/y.parquet'] = B;
    const stale = await open(); // its footer comes from the colo: the old upload
    await expect(stale.file.slice(0, 4)).rejects.toBeInstanceOf(StaleObjectError);
    const fresh = await open();
    expect(fresh.file.byteLength).toBe(B.byteLength);
    expect(new Uint8Array(await fresh.file.slice(0, 4))).toEqual(new Uint8Array(B.subarray(0, 4)));
  });
});

describe('the caller is told to retry', () => {
  it('a stale read is a 503 with Retry-After, not the generic 500', async () => {
    const res = queryFailure('Query', 'x')(new StaleObjectError('t/x.parquet'));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect((await res.json()).error).toMatch(/being updated/);
  });
});

describe('keys that did not change keep their colo copies', () => {
  it('a stale read of one key does not stop another key, or the new upload, being served from the colo', async () => {
    const objects: Record<string, Buffer> = { 't/a.parquet': A, 't/b.parquet': A };
    const cache = memoryCache();
    let gets = 0;
    const base = fakeR2(objects);
    const counting = { ...base, head: base.head, get: (k: string, o?: unknown) => { gets++; return base.get(k, o as never); } } as unknown as R2Bucket;
    const open = async (key: string) => {
      const waits: Promise<unknown>[] = [];
      const colo = coloCache(cache, (p) => waits.push(p));
      const opened = await openParquet(coloBucket(counting, colo, 'v1'), key, 16);
      colo.startPuts();
      await Promise.all(waits);
      return opened;
    };
    await open('t/a.parquet'); await open('t/b.parquet');
    clearHeadCache(); clearMetadataCache();
    objects['t/a.parquet'] = B;
    await expect((await open('t/a.parquet')).file.slice(0, 4)).rejects.toBeInstanceOf(StaleObjectError);
    await open('t/a.parquet'); // reads the new upload from R2 and keeps it
    clearHeadCache(); clearMetadataCache();
    gets = 0;
    await open('t/b.parquet');
    await open('t/a.parquet');
    expect(gets).toBe(0); // both footers from the colo: b untouched, a's new upload
  });
});
