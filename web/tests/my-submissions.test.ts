import { describe, it, expect, beforeEach } from 'vitest';
import {
  saveSubmission,
  listSubmissions,
  removeSubmission,
  getSubmission,
  hydrateLegacyTokens,
  MAX_SUBMISSIONS,
  type StoredSubmission,
} from '../src/my-submissions';

function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear() { m.clear(); },
    getItem(k) { return m.has(k) ? (m.get(k) as string) : null; },
    key(i) { return [...m.keys()][i] ?? null; },
    removeItem(k) { m.delete(k); },
    setItem(k, v) { m.set(k, String(v)); },
  } as Storage;
}

function rec(over: Partial<StoredSubmission> = {}): StoredSubmission {
  return {
    id: 'abc1234567',
    name: 'Bengaluru bike lanes',
    token: 'adm_xxxxxxxxxxxx',
    created_at: 1_700_000_000_000,
    permission: 'admin',
    ...over,
  };
}

describe('my-submissions — save & list', () => {
  let s: Storage;
  beforeEach(() => { s = memStorage(); });

  it('save writes a record under geodata:submissions:<id>', () => {
    saveSubmission(rec(), s);
    const raw = s.getItem('geodata:submissions:abc1234567');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).name).toBe('Bengaluru bike lanes');
  });

  it('list returns saved submissions sorted by created_at desc', () => {
    saveSubmission(rec({ id: 'old0000000', created_at: 1000 }), s);
    saveSubmission(rec({ id: 'new0000000', created_at: 9000 }), s);
    saveSubmission(rec({ id: 'mid0000000', created_at: 5000 }), s);
    expect(listSubmissions(s).map((r) => r.id)).toEqual(['new0000000', 'mid0000000', 'old0000000']);
  });

  it('list returns [] when storage is empty', () => {
    expect(listSubmissions(s)).toEqual([]);
  });

  it('list ignores unrelated keys', () => {
    s.setItem('geodata:tokens:abc1234567', 'adm_legacy');
    s.setItem('something:else', 'nope');
    expect(listSubmissions(s)).toEqual([]);
  });

  it('list tolerates corrupt JSON entries (skips them silently)', () => {
    s.setItem('geodata:submissions:bad0000000', '{not json');
    saveSubmission(rec({ id: 'good0000000' }), s);
    const got = listSubmissions(s);
    expect(got.map((r) => r.id)).toEqual(['good0000000']);
  });
});

describe('my-submissions — remove & get', () => {
  let s: Storage;
  beforeEach(() => { s = memStorage(); });

  it('remove deletes the record', () => {
    saveSubmission(rec(), s);
    removeSubmission('abc1234567', s);
    expect(listSubmissions(s)).toEqual([]);
  });

  it('get returns the record or null', () => {
    saveSubmission(rec(), s);
    expect(getSubmission('abc1234567', s)?.name).toBe('Bengaluru bike lanes');
    expect(getSubmission('missing', s)).toBeNull();
  });
});

describe('my-submissions — cap at 50', () => {
  it('drops the oldest when over MAX_SUBMISSIONS', () => {
    const s = memStorage();
    for (let i = 0; i < MAX_SUBMISSIONS + 5; i++) {
      saveSubmission(rec({ id: `id${String(i).padStart(8, '0')}`, created_at: i }), s);
    }
    const ids = listSubmissions(s).map((r) => r.id);
    expect(ids).toHaveLength(MAX_SUBMISSIONS);
    // The 5 oldest should have been evicted.
    expect(ids).not.toContain('id00000000');
    expect(ids).not.toContain('id00000004');
    expect(ids[0]).toBe(`id${String(MAX_SUBMISSIONS + 4).padStart(8, '0')}`);
  });
});

describe('my-submissions — storage unavailable', () => {
  function throwingStorage(): Storage {
    return {
      get length() { return 0; },
      clear() { throw new Error('nope'); },
      getItem() { throw new Error('nope'); },
      key() { throw new Error('nope'); },
      removeItem() { throw new Error('nope'); },
      setItem() { throw new Error('nope'); },
    } as Storage;
  }

  it('listSubmissions returns [] when storage throws', () => {
    expect(listSubmissions(throwingStorage())).toEqual([]);
  });

  it('saveSubmission is a no-op when storage throws', () => {
    expect(() => saveSubmission(rec(), throwingStorage())).not.toThrow();
  });

  it('removeSubmission is a no-op when storage throws', () => {
    expect(() => removeSubmission('abc1234567', throwingStorage())).not.toThrow();
  });
});

describe('my-submissions — hydrateLegacyTokens', () => {
  it('synthesises minimal records for orphan geodata:tokens:<id>', () => {
    const s = memStorage();
    s.setItem('geodata:tokens:legacy0001', 'adm_legacytoken');
    s.setItem('geodata:tokens:legacy0002', 'adm_othertoken');
    hydrateLegacyTokens(s, () => 12345);
    const got = listSubmissions(s);
    expect(got).toHaveLength(2);
    expect(got[0].name).toMatch(/^Submission /);
    expect(got[0].created_at).toBe(12345);
  });

  it('does not clobber existing rich records', () => {
    const s = memStorage();
    saveSubmission(rec({ id: 'rich0000001', name: 'Real name' }), s);
    s.setItem('geodata:tokens:rich0000001', 'adm_xxxxxxxxxxxx');
    hydrateLegacyTokens(s, () => 12345);
    expect(getSubmission('rich0000001', s)?.name).toBe('Real name');
  });
});
