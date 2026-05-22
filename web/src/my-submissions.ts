// Per-submission localStorage store for "Your submissions" on /preview.
//
// One key per submission (geodata:submissions:<id> = JSON record) instead of a
// single rolled-up array. Reasons: easier iteration, no read-modify-write race
// across tabs, and no collision if two devices write the same id from a
// .txt backup.
//
// Companion key geodata:tokens:<id> (single string token) still exists for
// /c/<id> owner detection — hydrateLegacyTokens() back-fills minimal rows so
// pre-v4.8 contributors see their submissions on first visit.

export type StoredSubmission = {
  id: string;
  name: string;
  token: string;
  created_at: number;
  permission: 'admin';
};

const PREFIX = 'geodata:submissions:';
const TOKEN_PREFIX = 'geodata:tokens:';
export const MAX_SUBMISSIONS = 50;

function defaultStorage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function saveSubmission(rec: StoredSubmission, storage?: Storage | null): void {
  const s = storage ?? defaultStorage();
  if (!s) return;
  try {
    s.setItem(PREFIX + rec.id, JSON.stringify(rec));
    s.setItem(TOKEN_PREFIX + rec.id, rec.token);
    enforceCap(s);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

export function listSubmissions(storage?: Storage | null): StoredSubmission[] {
  const s = storage ?? defaultStorage();
  if (!s) return [];
  try {
    const out: StoredSubmission[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const raw = s.getItem(k);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as StoredSubmission;
        if (rec && typeof rec.id === 'string' && typeof rec.token === 'string') {
          out.push(rec);
        }
      } catch {
        /* corrupt entry — skip */
      }
    }
    return out.sort((a, b) => b.created_at - a.created_at);
  } catch {
    return [];
  }
}

export function getSubmission(id: string, storage?: Storage | null): StoredSubmission | null {
  const s = storage ?? defaultStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(PREFIX + id);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSubmission;
  } catch {
    return null;
  }
}

export function removeSubmission(id: string, storage?: Storage | null): void {
  const s = storage ?? defaultStorage();
  if (!s) return;
  try {
    s.removeItem(PREFIX + id);
    s.removeItem(TOKEN_PREFIX + id);
  } catch {
    /* no-op */
  }
}

// Synthesise minimal rows for any geodata:tokens:<id> that lacks a rich record.
// Pre-v4.8 contributors only had the token key — calling this on /preview init
// keeps their submissions visible in the panel until they next visit /c/<id>
// (which will refresh the name from the server).
export function hydrateLegacyTokens(storage?: Storage | null, now: () => number = Date.now): void {
  const s = storage ?? defaultStorage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(TOKEN_PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      const id = k.slice(TOKEN_PREFIX.length);
      if (!id) continue;
      if (s.getItem(PREFIX + id)) continue;
      const token = s.getItem(k);
      if (!token) continue;
      const rec: StoredSubmission = {
        id,
        name: `Submission ${id}`,
        token,
        created_at: now(),
        permission: 'admin',
      };
      s.setItem(PREFIX + id, JSON.stringify(rec));
    }
  } catch {
    /* no-op */
  }
}

function enforceCap(s: Storage): void {
  // Fast path: count prefix-matching keys before doing the full sort.
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k && k.startsWith(PREFIX)) count++;
  }
  if (count <= MAX_SUBMISSIONS) return;
  for (const old of listSubmissions(s).slice(MAX_SUBMISSIONS)) {
    try { s.removeItem(PREFIX + old.id); } catch { /* no-op */ }
  }
}
