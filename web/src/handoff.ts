// One-shot file hand-off from /verify to /submit.
// sessionStorage holds tiny metadata; IndexedDB holds the blob.
// Pop is destructive — reload won't re-trigger the picked-up file.

const DB_NAME = 'geodata-handoff';
const STORE = 'pending';
const SESS_KEY = 'geodata:handoff';

type Meta = { name: string; size: number; lastModified: number; type: string };

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(blob: Blob): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(blob, 'file');
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function idbTake(): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get('file');
    getReq.onsuccess = () => {
      const blob = getReq.result as Blob | undefined;
      store.delete('file');
      tx.oncomplete = () => {
        db.close();
        resolve(blob ?? null);
      };
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function stashForSubmit(file: File): Promise<void> {
  const meta: Meta = {
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    type: file.type,
  };
  await idbPut(file);
  sessionStorage.setItem(SESS_KEY, JSON.stringify(meta));
}

export async function popHandoff(): Promise<File | null> {
  const raw = sessionStorage.getItem(SESS_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(SESS_KEY);
  let meta: Meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return null;
  }
  const blob = await idbTake();
  if (!blob) return null;
  return new File([blob], meta.name, { type: meta.type || 'application/octet-stream', lastModified: meta.lastModified });
}
