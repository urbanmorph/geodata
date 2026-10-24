// After "Create map & import" (or Manage → Import): every row of the file is
// accounted for. Rows the browser skipped and rows the server refused are both
// listed with their reason and the original row (for the download); a failed
// or unconfirmed import says so, with its reference, instead of going quiet.
import { describe, it, expect } from 'vitest';
import { importReport, importReportHtml } from '../src/import/report';
import { buildRecords } from '../src/import/build';
import { parseCSV } from '../src/import/parse';
import type { Field } from '../src/schema/validate-record';

const FIELDS: Field[] = [{ key: 'seg', label: 'Segment', type: 'text', required: true }, { key: 'w', label: 'Width', type: 'number' }];
const parsed = parseCSV('seg,w,lng,lat\nA,1,77.6,12.9\nB,2,,\nC,3,77.6,12.9\nD,4,77.6,12.9\nE,5,77.6,12.9\n');
const built = buildRecords(parsed.features, { fields: { seg: 'seg', w: 'w' }, lng: 'lng', lat: 'lat' }, FIELDS, ['point']);

describe('importReport', () => {
  it('lists rows skipped in the browser and rows the server refused, with their original cells', () => {
    // records sent: A, C, D, E (B had no coordinates); the server refused D (index 2)
    const r = importReport(parsed.features, built, { imported: 3, total: 4, errors: [{ index: 2, error: 'Width must be at most 3' }], attempt_id: 'att_x' });
    expect(r).toMatchObject({ total: 5, added: 3, attemptId: 'att_x' });
    expect(r.notAdded.map((e) => e.source.seg)).toEqual(['B', 'D']);
    expect(r.reasons).toEqual([
      { reason: 'no geometry (needs a geometry or lng/lat columns)', count: 1 },
      { reason: 'Width must be at most 3', count: 1 },
    ]);
  });

  it('a write that failed part way: the rows after the ones saved are listed as not added', () => {
    const r = importReport(parsed.features, built, { failed: 'Only 2 of 4 rows were added…', imported: 2, attemptId: 'att_y' });
    expect(r.added).toBe(2);
    expect(r.notAdded.map((e) => e.source.seg)).toEqual(['B', 'D', 'E']);
    expect(r.failed).toMatch(/Only 2 of 4/);
  });

  it('no reply at all: says the result is unknown rather than claiming nothing was added', () => {
    const r = importReport(parsed.features, built, { failed: 'Failed to fetch' });
    expect(r.unconfirmed).toBe(true);
  });
});

describe('importReportHtml', () => {
  it('reads plainly: how many of how many, why, the reference, and a download when rows are missing', () => {
    const r = importReport(parsed.features, built, { imported: 3, total: 4, errors: [{ index: 2, error: 'Width must be at most 3' }], attempt_id: 'att_x' });
    const html = importReportHtml(r);
    expect(html).toContain('3 of 5 rows added');
    expect(html).toContain('Width must be at most 3 (1)');
    expect(html).toContain('att_x');
    expect(html).toContain('id="dl-not-added"');
  });

  it('all rows added: no download, no warning', () => {
    const ok = buildRecords(parseCSV('seg,lng,lat\nA,77.6,12.9\n').features, { fields: { seg: 'seg' }, lng: 'lng', lat: 'lat' }, FIELDS, ['point']);
    const html = importReportHtml(importReport(parseCSV('seg,lng,lat\nA,77.6,12.9\n').features, ok, { imported: 1, total: 1, errors: [] }));
    expect(html).toContain('All 1 row added');
    expect(html).not.toContain('dl-not-added');
  });
});

describe('ApiError', () => {
  it('keeps the whole reply, so a reference and partial counts reach the page', async () => {
    const { ApiError, apiJson } = await import('../src/api');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Only 2 of 4', imported: 2, attempt_id: 'att_z' }), { status: 500 });
    try {
      await apiJson('/x', 't');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as InstanceType<typeof ApiError>).body).toMatchObject({ imported: 2, attempt_id: 'att_z' });
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('importFailure', () => {
  it('a refusal keeps its count and reference; no reply at all is unknown', async () => {
    const { importFailure } = await import('../src/import/report');
    const { ApiError } = await import('../src/api');
    expect(importFailure(new ApiError('Only 2 of 4', 500, { imported: 2, attempt_id: 'att_q' }))).toEqual({ failed: 'Only 2 of 4', imported: 2, attemptId: 'att_q' });
    expect(importFailure(new ApiError('unauthorised', 401, {}))).toMatchObject({ imported: 0 });
    expect(importFailure(new TypeError('Failed to fetch'))).toEqual({ failed: 'Failed to fetch' });
  });
});
