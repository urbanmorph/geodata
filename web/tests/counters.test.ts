import { describe, it, expect } from 'vitest';
import { incrementDownload, listDownloadCounts } from '../functions/lib/counters';

// Minimal in-memory fake of the D1 surface our counters helpers touch.
// Mirrors prepare().bind().run() / .all() — just enough for the tests.
function fakeD1() {
  const rows = new Map<string, { layer_id: string; state_code: string; format: string; count: number; last_at: string | null }>();
  return {
    rows,
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) {
          args = a;
          return this;
        },
        async run() {
          if (/INSERT INTO download_counts/.test(sql)) {
            const [layer_id, state_code, format, last_at] = args as [string, string, string, string];
            const key = `${layer_id}|${state_code}|${format}`;
            const cur = rows.get(key);
            if (cur) {
              cur.count++;
              cur.last_at = last_at;
            } else {
              rows.set(key, { layer_id, state_code, format, count: 1, last_at });
            }
          }
          return { success: true } as unknown;
        },
        async all() {
          if (/SELECT .* FROM download_counts/.test(sql)) {
            return { results: Array.from(rows.values()).map(({ last_at: _, ...r }) => r) } as unknown;
          }
          return { results: [] } as unknown;
        },
      };
    },
  };
}

describe('incrementDownload', () => {
  it('inserts a row on first call', async () => {
    const db = fakeD1();
    await incrementDownload(db as never, 'lgd_villages', '', 'parquet');
    expect(db.rows.size).toBe(1);
    const only = [...db.rows.values()][0];
    expect(only.count).toBe(1);
    expect(only.last_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('increments the same (layer, state, format) on repeated calls', async () => {
    const db = fakeD1();
    await incrementDownload(db as never, 'lgd_villages', '', 'parquet');
    await incrementDownload(db as never, 'lgd_villages', '', 'parquet');
    await incrementDownload(db as never, 'lgd_villages', '', 'parquet');
    expect(db.rows.size).toBe(1);
    expect([...db.rows.values()][0].count).toBe(3);
  });

  it('keeps distinct (layer, state, format) tuples in separate rows', async () => {
    const db = fakeD1();
    await incrementDownload(db as never, 'lgd_villages', '', 'parquet');
    await incrementDownload(db as never, 'lgd_villages', '29', 'parquet');
    await incrementDownload(db as never, 'lgd_villages', '29', 'kml');
    await incrementDownload(db as never, 'lgd_districts', '', 'parquet');
    expect(db.rows.size).toBe(4);
  });
});

describe('listDownloadCounts', () => {
  it('returns all rows from the table', async () => {
    const db = fakeD1();
    await incrementDownload(db as never, 'lgd_villages', '', 'parquet');
    await incrementDownload(db as never, 'lgd_districts', '29', 'kml');
    const rows = await listDownloadCounts(db as never);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.layer_id).sort()).toEqual(['lgd_districts', 'lgd_villages']);
  });
});
