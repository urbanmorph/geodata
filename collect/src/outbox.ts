// Offline capture queue. Every point is kept on the phone first (IndexedDB),
// then sent; it leaves the queue only once the server has it. A send that fails
// for want of signal, a server error, the rate limit or a captcha hiccup waits
// for the next try (app open, signal back, or the next save). A refusal that
// retrying can't fix (invalid point, link turned off, map closed) is kept with
// its reason for the person to see and discard. Nothing is dropped silently.
//
// Each point carries a random client_id, so if a send saved but its reply was
// lost, sending it again returns the same record instead of a duplicate.

/** A photo kept with its point until both are sent. id is set once uploaded.
 *  Kept as bytes, not a Blob: Safari won't store a Blob in IndexedDB in some
 *  cases (private browsing among them), and an ArrayBuffer stores everywhere. */
export interface QueuedPhoto {
  client_id: string;
  field: string; // the Photo question it answers
  bytes: ArrayBuffer;
  meta: { lat?: number; lng?: number; taken_at?: string; source?: 'camera' | 'gallery' };
  id?: string;
}

export interface QueuedPoint {
  client_id: string;
  collection_id: string;
  map_name: string;
  token: string; // the collect (or admin) link token it was captured with
  geometry: GeoJSON.Geometry;
  properties: Record<string, unknown>;
  contributor: string;
  label: string; // for "Your additions" and the queue list
  noun: string; // point, line or area
  created_at: string;
  /** When it was really captured, if earlier (the photo's time, for a point placed from its photo). */
  captured_at?: string;
  photos?: QueuedPhoto[];
  error?: string; // why the server refused it for good
}

export type SendResult =
  | { ok: true; id: string; status: string; edit_token: string }
  | { ok: false; status: number; error: string }; // status 0: no connection

export interface OutboxStore {
  all(): Promise<QueuedPoint[]>;
  put(p: QueuedPoint): Promise<void>;
  delete(clientId: string): Promise<void>;
}

/** The request body for sending a queued point. created_at is when the phone
 *  captured it; the server keeps it as captured_at. */
export function sendBody(p: QueuedPoint, turnstile_token: string): string {
  const properties = { ...p.properties };
  for (const ph of p.photos ?? []) if (ph.id) properties[ph.field] = [...((properties[ph.field] as string[] | undefined) ?? []), ph.id];
  return JSON.stringify({
    geometry: p.geometry, properties, contributor: p.contributor, client_id: p.client_id,
    captured_at: p.captured_at ?? p.created_at, turnstile_token,
  });
}

export type UploadResult = { ok: true; id: string } | { ok: false; status: number; error: string };

/** Uploads a point's photos that aren't on the server yet, keeping each id on
 *  the phone as it arrives, so a send that stops halfway resumes where it was. */
export async function uploadPhotos(
  p: QueuedPoint, store: OutboxStore, upload: (p: QueuedPoint, photo: QueuedPhoto) => Promise<UploadResult>,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  for (const photo of p.photos ?? []) {
    if (photo.id) continue;
    const r = await upload(p, photo);
    if (!r.ok) return r;
    photo.id = r.id;
    await store.put(p);
  }
  return { ok: true };
}

export function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Whether a failed send is worth retrying later, or was refused for good. */
export function fate(r: { status: number; error: string }): 'later' | 'refused' {
  if (r.status === 0 || r.status >= 500 || r.status === 429 || r.status === 408) return 'later';
  if (r.status === 403 && /captcha/i.test(r.error)) return 'later';
  return 'refused';
}

export interface FlushResult {
  sent: { point: QueuedPoint; result: Extract<SendResult, { ok: true }> }[];
}

// One flush at a time: a save, the app opening and signal returning can all ask
// at once. Each call waits for the one before it and then reads the queue
// afresh, so a point is sent once, and a point saved mid-flush isn't missed.
let last: Promise<unknown> = Promise.resolve();

/** Sends queued points oldest first, stopping at the first one that must wait. */
export function flush(store: OutboxStore, send: (p: QueuedPoint) => Promise<SendResult>): Promise<FlushResult> {
  const run = last.catch(() => {}).then(async (): Promise<FlushResult> => {
    const sent: FlushResult['sent'] = [];
    const queue = (await store.all()).filter((p) => !p.error).sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const point of queue) {
      const result = await send(point);
      if (result.ok) {
        await store.delete(point.client_id);
        sent.push({ point, result });
      } else if (fate(result) === 'refused') {
        await store.put({ ...point, error: result.error });
      } else break;
    }
    return { sent };
  });
  last = run;
  return run;
}

// ---- the browser store (IndexedDB) -------------------------------------------

const DB_NAME = 'collect-outbox';
const STORE = 'points';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'client_id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      // Always an Error with words, whatever the browser hands back (Safari can give null).
      const fail = (): void => reject(tx.error ?? req.error ?? new Error("couldn't keep it on this phone (storage refused)"));
      tx.onerror = fail;
      tx.onabort = fail;
    });
  } finally {
    db.close();
  }
}

export const idbOutbox: OutboxStore = {
  all: () => run('readonly', (s) => s.getAll() as IDBRequest<QueuedPoint[]>),
  put: async (p) => void (await run('readwrite', (s) => s.put(p))),
  delete: async (id) => void (await run('readwrite', (s) => s.delete(id))),
};
