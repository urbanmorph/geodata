import { describe, it, expect } from 'vitest';
import {
  insertSubmission,
  insertToken,
  findDuplicateByHash,
  getSubmissionForView,
  type SubmissionRow,
} from '../functions/lib/submissions';

type SubRow = SubmissionRow & {
  created_at: string;
  validation_report: string | null;
  rejection_reason: string | null;
};

type TokRow = {
  id: string;
  submission_id: string;
  token_prefix: string;
  token_hash: string;
  permission: string;
  is_active: number;
  expires_at: string | null;
  created_at: string;
};

function fakeD1() {
  const subs = new Map<string, SubRow>();
  const tokens = new Map<string, TokRow>();
  return {
    subs,
    tokens,
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) {
          args = a;
          return this;
        },
        async run() {
          if (/INSERT INTO submissions/.test(sql)) {
            const [
              id,
              created_at,
              status,
              name,
              description,
              category,
              license,
              attribution,
              source_url,
              data_year,
              is_original,
              format,
              bytes,
              feature_count,
              geometry_types,
              content_hash,
              ip_hash,
              validation_report,
              r2_key,
            ] = args as [
              string,
              string,
              string,
              string,
              string | null,
              string,
              string,
              string,
              string,
              number | null,
              0 | 1,
              string,
              number,
              number | null,
              string | null,
              string | null,
              string,
              string | null,
              string,
            ];
            subs.set(id, {
              id,
              created_at,
              status,
              name,
              description,
              category,
              license,
              attribution,
              source_url,
              data_year,
              is_original,
              format,
              bytes,
              feature_count,
              geometry_types,
              content_hash,
              ip_hash,
              validation_report,
              rejection_reason: null,
              r2_key,
            });
          } else if (/INSERT INTO submission_tokens/.test(sql)) {
            const [id, submission_id, token_prefix, token_hash, permission, expires_at, created_at] = args as [
              string,
              string,
              string,
              string,
              string,
              string | null,
              string,
            ];
            tokens.set(id, {
              id,
              submission_id,
              token_prefix,
              token_hash,
              permission,
              is_active: 1,
              expires_at,
              created_at,
            });
          }
          return { success: true };
        },
        async first() {
          if (/SELECT id FROM submissions WHERE content_hash/.test(sql)) {
            const [content_hash] = args as [string];
            for (const s of subs.values()) {
              if (s.content_hash === content_hash && s.status === 'accepted') {
                return { id: s.id };
              }
            }
            return null;
          }
          if (/SELECT id, created_at[\s\S]*FROM submissions WHERE id =/.test(sql)) {
            const [id] = args as [string];
            const s = subs.get(id);
            return s && s.status === 'accepted' ? s : null;
          }
          return null;
        },
      };
    },
  };
}

const baseRow = (): SubmissionRow => ({
  id: 'abc1234567',
  status: 'accepted',
  name: 'Mumbai bike lanes',
  description: 'BBMP bike infra',
  category: 'infrastructure',
  license: 'CC-BY-4.0',
  attribution: 'BBMP Open Data Portal',
  source_url: 'https://example.com/data',
  data_year: 2024,
  is_original: 0,
  format: 'geojson',
  bytes: 1024,
  feature_count: 234,
  geometry_types: 'Polygon,MultiPolygon',
  content_hash: 'a'.repeat(64),
  ip_hash: 'iphash1',
  validation_report: '{"geometry":{"ok":true}}',
  r2_key: 'community/abc1234567/file.geojson',
});

describe('insertSubmission', () => {
  it('writes a submission row with all fields', async () => {
    const db = fakeD1();
    await insertSubmission(db as never, baseRow());
    expect(db.subs.size).toBe(1);
    const row = db.subs.get('abc1234567');
    expect(row?.name).toBe('Mumbai bike lanes');
    expect(row?.license).toBe('CC-BY-4.0');
    expect(row?.content_hash).toBe('a'.repeat(64));
    expect(row?.r2_key).toBe('community/abc1234567/file.geojson');
    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('persists the validation_report as JSON text', async () => {
    const db = fakeD1();
    await insertSubmission(db as never, baseRow());
    const row = db.subs.get('abc1234567');
    expect(typeof row?.validation_report).toBe('string');
    expect(JSON.parse(row!.validation_report!).geometry.ok).toBe(true);
  });
});

describe('insertToken', () => {
  it('writes a token row with prefix + hash + permission', async () => {
    const db = fakeD1();
    await insertToken(db as never, {
      submissionId: 'abc1234567',
      tokenPrefix: 'adm_xxxx',
      tokenHash: 'b'.repeat(64),
      permission: 'admin',
    });
    expect(db.tokens.size).toBe(1);
    const row = [...db.tokens.values()][0];
    expect(row.submission_id).toBe('abc1234567');
    expect(row.token_prefix).toBe('adm_xxxx');
    expect(row.token_hash).toBe('b'.repeat(64));
    expect(row.permission).toBe('admin');
    expect(row.is_active).toBe(1);
  });

  it('accepts an optional expires_at', async () => {
    const db = fakeD1();
    const ts = '2099-12-31T23:59:59.000Z';
    await insertToken(db as never, {
      submissionId: 'abc1234567',
      tokenPrefix: 'adm_xxxx',
      tokenHash: 'b'.repeat(64),
      permission: 'admin',
      expiresAt: ts,
    });
    const row = [...db.tokens.values()][0];
    expect(row.expires_at).toBe(ts);
  });
});

describe('findDuplicateByHash', () => {
  it('returns the matching submission id when an accepted submission exists', async () => {
    const db = fakeD1();
    await insertSubmission(db as never, { ...baseRow(), id: 'sub1' });
    const match = await findDuplicateByHash(db as never, 'a'.repeat(64));
    expect(match).toBe('sub1');
  });

  it('returns null when no match', async () => {
    const db = fakeD1();
    await insertSubmission(db as never, { ...baseRow(), id: 'sub1' });
    const match = await findDuplicateByHash(db as never, 'c'.repeat(64));
    expect(match).toBeNull();
  });

  it('ignores rejected / retracted submissions', async () => {
    const db = fakeD1();
    await insertSubmission(db as never, { ...baseRow(), id: 'sub1', status: 'rejected' });
    const match = await findDuplicateByHash(db as never, 'a'.repeat(64));
    expect(match).toBeNull();
  });
});

describe('getSubmissionForView', () => {
  it('returns the row for an accepted submission', async () => {
    const db = fakeD1();
    await insertSubmission(db as never, { ...baseRow(), id: 'sub1' });
    const r = await getSubmissionForView(db as never, 'sub1');
    expect(r?.name).toBe('Mumbai bike lanes');
    expect(r?.r2_key).toBe('community/abc1234567/file.geojson');
    expect(r?.is_original).toBe(0);
  });

  it('preserves is_original=1 round-trip', async () => {
    const db = fakeD1();
    await insertSubmission(db as never, { ...baseRow(), id: 'sub1', is_original: 1, source_url: 'Hand-digitized in QGIS' });
    const r = await getSubmissionForView(db as never, 'sub1');
    expect(r?.is_original).toBe(1);
    expect(r?.source_url).toBe('Hand-digitized in QGIS');
  });

  it('returns null for a rejected / retracted submission', async () => {
    const db = fakeD1();
    await insertSubmission(db as never, { ...baseRow(), id: 'sub1', status: 'rejected' });
    expect(await getSubmissionForView(db as never, 'sub1')).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    const db = fakeD1();
    expect(await getSubmissionForView(db as never, 'missing')).toBeNull();
  });
});
