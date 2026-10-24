// Offline capture queue: every point is kept on the phone first, then sent.
// A point leaves the queue only when the server has it; nothing is dropped
// silently. A refusal that retrying can't fix is kept with its reason for the
// person to see and discard.
import { describe, it, expect } from 'vitest';
import { flush, fate, newClientId, uploadPhotos, sendBody, type QueuedPoint, type OutboxStore, type SendResult } from '../src/outbox';

function memoryStore(points: QueuedPoint[] = []): OutboxStore & { rows: Map<string, QueuedPoint> } {
  const rows = new Map(points.map((p) => [p.client_id, p]));
  return {
    rows,
    all: async () => [...rows.values()],
    put: async (p) => void rows.set(p.client_id, { ...p }),
    delete: async (id) => void rows.delete(id),
  };
}

let n = 0;
const point = (over: Partial<QueuedPoint> = {}): QueuedPoint => ({
  client_id: `client-id-${String(++n).padStart(8, '0')}`,
  collection_id: 'map1', map_name: 'Ward trees', token: 'edt_x',
  geometry: { type: 'Point', coordinates: [77.59, 12.97] },
  properties: { name: 'Neem' }, contributor: '', label: 'Neem', noun: 'point',
  created_at: new Date(Date.UTC(2026, 9, 22, 10, 0, n)).toISOString(),
  ...over,
});
const ok = (id: string): SendResult => ({ ok: true, id, status: 'published', edit_token: `rec_${id}` });
const no = (status: number, error = 'nope') => ({ ok: false as const, status, error });

describe('newClientId', () => {
  it('is random, url-safe and long enough for the server (16 to 64 chars)', () => {
    const a = newClientId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(newClientId()).not.toBe(a);
  });
});

describe('fate of a failed send', () => {
  it('waits and retries later: no connection, server error, rate limit, captcha', () => {
    expect(fate(no(0))).toBe('later');
    expect(fate(no(502))).toBe('later');
    expect(fate(no(429))).toBe('later');
    expect(fate(no(403, 'captcha failed'))).toBe('later');
  });
  it('is refused for good: invalid point, link turned off, map closed or gone', () => {
    expect(fate(no(400))).toBe('refused');
    expect(fate(no(401))).toBe('refused');
    expect(fate(no(403, 'this collection is closed to new records'))).toBe('refused');
    expect(fate(no(404))).toBe('refused');
  });
});

describe('flush', () => {
  it('sends queued points oldest first and removes each once the server has it', async () => {
    const a = point(), b = point();
    const store = memoryStore([b, a]);
    const order: string[] = [];
    const r = await flush(store, async (p) => (order.push(p.client_id), ok(p.client_id)));
    expect(order).toEqual([a.client_id, b.client_id]);
    expect(store.rows.size).toBe(0);
    expect(r.sent.map((s) => s.point.client_id)).toEqual([a.client_id, b.client_id]);
    expect(r.sent[0].result).toEqual(ok(a.client_id));
  });

  it('with no connection, keeps every point and stops at the first failure', async () => {
    const store = memoryStore([point(), point()]);
    let calls = 0;
    const r = await flush(store, async () => (calls++, no(0)));
    expect(calls).toBe(1);
    expect(store.rows.size).toBe(2);
    expect(r.sent).toEqual([]);
  });

  it('on a rate limit, stops and keeps the rest for later', async () => {
    const a = point(), b = point(), c = point();
    const store = memoryStore([a, b, c]);
    const r = await flush(store, async (p) => (p.client_id === a.client_id ? ok('r1') : no(429)));
    expect([...store.rows.keys()]).toEqual([b.client_id, c.client_id]);
    expect(r.sent).toHaveLength(1);
  });

  it('keeps a refused point with its reason, skips it next time, and carries on', async () => {
    const bad = point(), good = point();
    const store = memoryStore([bad, good]);
    await flush(store, async (p) => (p.client_id === bad.client_id ? no(400, 'name is required') : ok('r2')));
    expect([...store.rows.values()]).toEqual([{ ...bad, error: 'name is required' }]);
    let sentAgain = false;
    await flush(store, async () => ((sentAgain = true), ok('x')));
    expect(sentAgain).toBe(false);
    expect(store.rows.size).toBe(1);
  });

  it('a second flush while one is running does not send anything twice', async () => {
    const store = memoryStore([point(), point()]);
    let sends = 0;
    const send = async (p: QueuedPoint) => { sends++; await new Promise((r) => setTimeout(r, 5)); return ok(p.client_id); };
    await Promise.all([flush(store, send), flush(store, send)]);
    expect(sends).toBe(2);
  });

  it('a point saved while a flush is running is sent by the next flush', async () => {
    const first = point(), late = point();
    const store = memoryStore([first]);
    const sent: string[] = [];
    let b: Promise<Awaited<ReturnType<typeof flush>>> | undefined;
    const send = async (p: QueuedPoint) => {
      sent.push(p.client_id);
      if (p === first || p.client_id === first.client_id) {
        // Saved while the first point is on its way: its own flush must send it.
        await store.put(late);
        b = flush(store, send);
      }
      return ok(p.client_id);
    };
    await flush(store, send);
    const second = await b!;
    expect(sent).toEqual([first.client_id, late.client_id]);
    expect(second.sent.map((s) => s.point.client_id)).toEqual([late.client_id]);
  });
});

describe('what a queued point sends', () => {
  it('includes the time it was captured, so a point sent later keeps its real time', async () => {
    const { sendBody } = await import('../src/outbox');
    const p = { client_id: 'c'.repeat(22), collection_id: 'm1', map_name: 'Trees', token: 'edt_x', geometry: { type: 'Point', coordinates: [77.6, 12.9] } as GeoJSON.Geometry,
      properties: { name: 'Neem' }, contributor: 'Asha', label: 'Neem', noun: 'point', created_at: '2026-10-24T05:10:00.000Z' };
    expect(JSON.parse(sendBody(p, 'tt'))).toEqual({
      geometry: p.geometry, properties: { name: 'Neem' }, contributor: 'Asha', client_id: p.client_id,
      captured_at: '2026-10-24T05:10:00.000Z', turnstile_token: 'tt',
    });
  });
});

describe('photos waiting with a point', () => {
  const photo = (field: string, id?: string) => ({ client_id: `photo-client-${++n}-xxxxxx`, field, bytes: new Uint8Array([0xff, 0xd8, 0xff]).buffer, meta: { source: 'camera' as const }, ...(id ? { id } : {}) });

  it('uploads each photo once, remembering its id on the phone, then fills the answers', async () => {
    const p = point({ photos: [photo('pic'), photo('pic'), photo('other')] });
    const store = memoryStore([p]);
    let k = 0;
    const r = await uploadPhotos(p, store, async () => ({ ok: true, id: `ph_uploaded${++k}aaaa` }));
    expect(r.ok).toBe(true);
    expect(k).toBe(3);
    const kept = store.rows.get(p.client_id)!;
    expect(kept.photos!.map((x) => x.id)).toEqual(['ph_uploaded1aaaa', 'ph_uploaded2aaaa', 'ph_uploaded3aaaa']);
    const body = JSON.parse(sendBody(kept, 't'));
    expect(body.properties).toEqual({ name: 'Neem', pic: ['ph_uploaded1aaaa', 'ph_uploaded2aaaa'], other: ['ph_uploaded3aaaa'] });
  });

  it('a retry skips photos already uploaded', async () => {
    const p = point({ photos: [photo('pic', 'ph_alreadyhere01'), photo('pic')] });
    const store = memoryStore([p]);
    const sent: string[] = [];
    await uploadPhotos(p, store, async (_pt, ph) => (sent.push(ph.client_id), { ok: true, id: 'ph_second0000001' }));
    expect(sent).toHaveLength(1);
  });

  it('stops at a failed upload and says why, so the point waits or is refused like any send', async () => {
    const p = point({ photos: [photo('pic'), photo('pic')] });
    const store = memoryStore([p]);
    const r = await uploadPhotos(p, store, async () => ({ ok: false, status: 0, error: 'no connection' }));
    expect(r).toEqual({ ok: false, status: 0, error: 'no connection' });
  });
});
