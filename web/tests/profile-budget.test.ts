// A fair time budget for a point profile (lib/profile.ts). Every R2 read waits for one
// of the Worker's six connections, so when every layer's clock started with the answer,
// a congested call spent the budget of the layers at the back of the queue on waiting:
// one Kolkata surface answer listed 13 layers as unavailable. Reads now take turns, the
// layers earlier in the table first, and a layer's clock stops while all it does is wait
// for a turn; one deadline bounds the whole answer.
import { describe, it, expect } from 'vitest';
import { BASE_DEPS, LAYER_BUDGET_MS, ANSWER_DEADLINE_MS, partialByChance, profileAt, type ProfileDeps, type ProfileSpec } from '../functions/lib/profile';
import { turns } from '../functions/lib/concurrency';
import type { CatalogData, CatalogLayer } from '../functions/lib/catalog-api';
import type { LocateResponse } from '../functions/lib/locate';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A bucket like the Worker's: six connections, each read taking `ms`; reads past six wait. */
function slowBucket(ms: number, stuck = new Set<string>()) {
  let busy = 0;
  const waiting: Array<() => void> = [];
  const reads: string[] = [];
  const bucket = {
    async get(key: string) {
      reads.push(key);
      if (stuck.has(key)) return new Promise(() => {});
      if (busy >= 6) await new Promise<void>((r) => waiting.push(r));
      else busy++;
      await sleep(ms);
      const next = waiting.shift();
      if (next) next(); else busy--;
      return { key };
    },
  } as unknown as R2Bucket;
  return { bucket, reads };
}

const ids = Array.from({ length: 24 }, (_, i) => `l${i}`);
const catalog = { layers: ids.map((id) => ({ id, source: 'S', licence: 'CC0-1.0' }) as unknown as CatalogLayer) } as CatalogData;
const spec: ProfileSpec = {
  layers: ids.map((id) => ({ id, section: 'place', match: 'contains' as const })),
  sections: ['place'], pixels: [], disclaimer: '', nothing: '',
};

/** Each layer reads its tile `n` times, one after another, through the bucket it is given. */
const readingDeps = (n = 1): ProfileDeps => ({
  ...BASE_DEPS, pixels: {},
  locate: async (lat, lng, layerIds, _zoom, _catalog, r2) => {
    for (let i = 0; i < n; i++) await r2.get(layerIds![0]);
    return {
      point: { lat, lng }, zoom: 14, queried_layers: layerIds!, timing_ms: 0,
      results: { place: [{ layer_id: layerIds![0], feature: { properties: { n: 1 } } }] },
    } as unknown as LocateResponse;
  },
});

describe('a fair budget for a point profile', () => {
  it('a congested call does not drop the layers at the back of the queue', async () => {
    // 24 layers, two reads each, six connections, 30 ms a read: 240 ms in all, though no layer reads for more than 60
    const { bucket } = slowBucket(30);
    const p = await profileAt(spec, 22.55, 88.36, catalog, bucket, readingDeps(2), { budgetMs: 90, deadlineMs: 2000 });
    expect(p.unavailable).toEqual([]);
    expect(Object.keys(p.sections.place)).toHaveLength(24);
  });

  it('one deadline bounds the answer: a layer whose reads never got a turn is named, and the answer is not kept', async () => {
    const { bucket, reads } = slowBucket(30);
    const t0 = Date.now();
    const p = await profileAt(spec, 22.55, 88.36, catalog, bucket, readingDeps(), { budgetMs: 50, deadlineMs: 70 });
    expect(Date.now() - t0).toBeLessThan(150);
    // turns at 0, 30 and 60 ms: the third is cut at 70, the fourth never reads
    expect(reads).toHaveLength(18);
    expect(p.unavailable).toHaveLength(12);
    for (const u of p.unavailable) expect(u.reason).toBe("took longer than the answer's 70 ms");
    expect(partialByChance(p)).toBe(true);
    expect(Object.keys(p.sections.place)).toHaveLength(12);
  });

  it('a layer whose read never answers is out at its own budget and gives up its turn', async () => {
    const stuck = new Set(['l0', 'l1', 'l2', 'l3', 'l4', 'l5']);
    const { bucket } = slowBucket(5, stuck);
    const held: Promise<unknown>[] = [];
    const p = await profileAt(spec, 22.55, 88.36, catalog, bucket, readingDeps(), { budgetMs: 40, deadlineMs: 1000, waitUntil: (w) => held.push(w) });
    expect(p.unavailable.map((u) => u.layer_id).sort()).toEqual([...stuck].sort());
    for (const u of p.unavailable) expect(u.reason).toBe('took longer than 40 ms');
    expect(Object.keys(p.sections.place)).toHaveLength(18);
    expect(held).toHaveLength(6); // their reads run on in waitUntil
  });

  it('a layer that waits for no read runs on its clock from the start', async () => {
    const deps: ProfileDeps = { ...readingDeps(), locate: () => new Promise(() => {}) };
    const p = await profileAt(spec, 22.55, 88.36, catalog, slowBucket(1).bucket, deps, { budgetMs: 20, deadlineMs: 1000 });
    expect(p.unavailable).toHaveLength(24);
    for (const u of p.unavailable) expect(u.reason).toBe('took longer than 20 ms');
  });

  it('defaults: 2.5 s a layer (its own time), 4 s an answer', () => {
    expect(LAYER_BUDGET_MS).toBe(2500);
    expect(ANSWER_DEADLINE_MS).toBe(4000);
  });
});

describe('turns', () => {
  it('lets `limit` hold at once, then hands each turn to the lowest rank waiting (first come among equals)', async () => {
    const q = turns(2);
    const order: string[] = [];
    const a = await q.acquire(5);
    const b = await q.acquire(5);
    const waits = [['c', 3], ['d', 1], ['e', 3]].map(([name, rank]) => q.acquire(rank as number).then((give) => { order.push(name as string); return give; }));
    a();
    a(); // a second call gives nothing back
    await sleep(0);
    expect(order).toEqual(['d']);
    b();
    (await waits[1])();
    await Promise.all(waits);
    expect(order).toEqual(['d', 'c', 'e']);
  });
});
