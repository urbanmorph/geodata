import { describe, it, expect } from 'vitest';
import { validateSubmission, type SubmissionInput, type ValidationDeps } from '../functions/lib/validate-server';
import type { FC } from '../src/validate';

function pointFC(x = 72.8, y = 19.0): FC {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { name: 'x' } }],
  };
}

function input(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    turnstileToken: 'ok',
    ipHash: 'A',
    filename: 'mumbai_bike_lanes.geojson',
    bytes: 1024,
    contentHash: 'a'.repeat(64),
    fc: pointFC(),
    rawJson: undefined,
    name: 'Mumbai bike lanes',
    description: null,
    category: 'infrastructure',
    license: 'CC-BY-4.0',
    attribution: 'BBMP Open Data Portal',
    sourceUrl: 'https://example.com/data',
    ...overrides,
  };
}

function deps(overrides: Partial<ValidationDeps> = {}): ValidationDeps {
  return {
    verifyCaptcha: async () => true,
    checkRate: async () => ({ ok: true }),
    findDuplicate: async () => null,
    ...overrides,
  };
}

describe('validateSubmission — accept path', () => {
  it('accepts a clean submission', async () => {
    const r = await validateSubmission(input(), deps());
    expect(r.accept).toBe(true);
  });
});

describe('validateSubmission — hard reject gates', () => {
  it('rejects when captcha fails', async () => {
    const r = await validateSubmission(input(), deps({ verifyCaptcha: async () => false }));
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/captcha/i);
  });

  it('rejects when rate-limit blocks', async () => {
    const r = await validateSubmission(
      input(),
      deps({ checkRate: async () => ({ ok: false, retryAfter: 1800 }) }),
    );
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/rate/i);
  });

  it('rejects when bytes exceed 500 MB', async () => {
    const r = await validateSubmission(input({ bytes: 600 * 1024 * 1024 }), deps());
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/size|too large/i);
  });

  it('rejects an unknown filename extension', async () => {
    const r = await validateSubmission(input({ filename: 'bad.docx' }), deps());
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/format/i);
  });

  it('rejects a non-EPSG:4326 declared CRS', async () => {
    const r = await validateSubmission(
      input({ rawJson: { crs: { properties: { name: 'urn:ogc:def:crs:EPSG::3857' } } } }),
      deps(),
    );
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/crs/i);
  });

  it('accepts an explicit CRS84 declaration', async () => {
    const r = await validateSubmission(
      input({ rawJson: { crs: { properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } } } }),
      deps(),
    );
    expect(r.accept).toBe(true);
  });

  it('rejects when geometry validity drops below 95%', async () => {
    const fc: FC = {
      type: 'FeatureCollection',
      features: [],
    };
    for (let i = 0; i < 20; i++) {
      const valid = i < 18; // 90% valid
      fc.features.push({
        type: 'Feature',
        geometry: valid ? { type: 'Point', coordinates: [72.8, 19.0] } : null,
        properties: null,
      });
    }
    const r = await validateSubmission(input({ fc }), deps());
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/geometr/i);
  });

  it('rejects an unknown licence id', async () => {
    const r = await validateSubmission(input({ license: 'CC-BY-NC-4.0' }), deps());
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/licence|license/i);
  });

  it('rejects too-short attribution', async () => {
    const r = await validateSubmission(input({ attribution: 'a' }), deps());
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/attribution/i);
  });

  it('rejects a non-http source URL', async () => {
    const r = await validateSubmission(input({ sourceUrl: 'javascript:alert(1)' }), deps());
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/source/i);
  });

  it('rejects a too-short name', async () => {
    const r = await validateSubmission(input({ name: 'x' }), deps());
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/name/i);
  });

  it('rejects a filename with control chars', async () => {
    const r = await validateSubmission(input({ filename: 'bad\x00name.geojson' }), deps());
    expect(r.accept).toBe(false);
    if (!r.accept) expect(r.reason).toMatch(/filename/i);
  });
});

describe('validateSubmission — soft warnings (accept with flags)', () => {
  it('accepts but warns when the extent is outside India', async () => {
    const r = await validateSubmission(input({ fc: pointFC(2.3, 48.8) /* Paris */ }), deps());
    expect(r.accept).toBe(true);
    if (r.accept) expect(r.report.extent?.warn).toBe(true);
  });

  it('accepts but warns when a duplicate content_hash exists', async () => {
    const r = await validateSubmission(input(), deps({ findDuplicate: async () => 'ABC123XYZ0' }));
    expect(r.accept).toBe(true);
    if (r.accept) {
      expect(r.report.duplicate?.warn).toBe(true);
      expect(r.report.duplicate?.info?.matchId).toBe('ABC123XYZ0');
    }
  });
});

describe('validateSubmission — format detection', () => {
  it.each([
    ['file.geojson', true],
    ['file.json', true],
    ['file.kml', true],
    ['file.kmz', true],
    ['file.parquet', true],
    ['file.GEOJSON', true],
    ['file.shp', false],
    ['file.zip', false],
    ['file', false],
  ])('format detect for %s -> ok=%s', async (filename, ok) => {
    const r = await validateSubmission(input({ filename }), deps());
    expect(r.accept).toBe(ok);
  });
});
