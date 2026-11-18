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
  captcha_fails?: number; // failed spam checks in a row (it still waits; see stuckReason)
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

/** The server says a photo the point names isn't there (it was cleared while the
 *  phone was offline for weeks): upload the point's photos again. */
export const photosMissing = (r: { status: number; error: string }): boolean =>
  r.status === 400 && /photo was not uploaded to this map/.test(r.error);

export const forgetUploads = (p: QueuedPoint): QueuedPoint =>
  ({ ...p, photos: p.photos?.map(({ id: _id, ...rest }) => rest) });

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

const isCaptcha = (r: { status: number; error: string }): boolean => r.status === 403 && /captcha/i.test(r.error);

/** After this many failed spam checks in a row, the queue says why it's stuck. */
export const CAPTCHA_FAILS_TO_SAY = 3;

/** Why waiting points aren't going, in plain words, when it isn't just the signal. */
export function stuckReason(points: QueuedPoint[]): string | null {
  return points.some((p) => !p.error && (p.captcha_fails ?? 0) >= CAPTCHA_FAILS_TO_SAY)
    ? "The server's spam check isn't passing on this phone. Turning off an ad or content blocker, or trying another network, usually helps."
    : null;
}

// One flush at a time: a save, the app opening and signal returning can all ask
// at once. Each call waits for the one before it and then reads the queue
// afresh, so a point is sent once, and a point saved mid-flush isn't missed.
// Across tabs (two tabs, or the app and a tab), a browser lock does the same,
// where the browser has one; otherwise it's one flush at a time per tab.
let last: Promise<unknown> = Promise.resolve();
const OUTBOX_LOCK = 'collect-outbox';

type LockManager = { request<T>(name: string, cb: () => Promise<T>): Promise<T> };
const locks = (): LockManager | undefined => (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;

/** Sends queued points oldest first. No connection stops the run; a map that
 *  answers 429 is skipped for the rest of it; a point the server fails on waits
 *  while the others go; a failed spam check is counted on the point. */
export function flush(store: OutboxStore, send: (p: QueuedPoint) => Promise<SendResult>): Promise<FlushResult> {
  const body = async (): Promise<FlushResult> => {
    const sent: FlushResult['sent'] = [];
    const busyMaps = new Set<string>();
    const queue = (await store.all()).filter((p) => !p.error).sort((a, b) => a.created_at.localeCompare(b.created_at));
    for (const point of queue) {
      if (busyMaps.has(point.collection_id)) continue;
      const result = await send(point);
      if (result.ok) {
        await store.delete(point.client_id);
        sent.push({ point, result });
      } else if (fate(result) === 'refused') {
        await store.put({ ...point, error: result.error });
      } else if (result.status === 429) {
        busyMaps.add(point.collection_id);
      } else if (isCaptcha(result)) {
        // The check is per phone, not per point: the rest would fail the same way.
        await store.put({ ...point, captcha_fails: (point.captcha_fails ?? 0) + 1 });
        break;
      } else if (result.status === 0) {
        break; // no connection: nothing else would get through either
      } // else a server error on this point: it waits, the next one goes
    }
    return { sent };
  };
  const lm = locks();
  const run = last.catch(() => {}).then(() => (lm ? lm.request(OUTBOX_LOCK, body) : body()));
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
