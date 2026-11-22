// One format -> MIME table (shared/mime.mjs). Parquet was application/x-parquet
// for submissions and their /c page but application/vnd.apache.parquet (the
// IANA-registered type) on /view; a submitted .json (a GeoJSON
// FeatureCollection) was stored as geo+json but described as plain JSON.
import { describe, it, expect } from 'vitest';
import { mimeFor } from '../../shared/mime.mjs';
import { renderViewPage } from '../functions/lib/render-view';
import type { SubmissionView } from '../functions/lib/submissions';

describe('mimeFor', () => {
  it('names parquet by its IANA-registered type', () => {
    expect(mimeFor('parquet')).toBe('application/vnd.apache.parquet');
  });

  it('treats a .json file as the GeoJSON it is', () => {
    expect(mimeFor('json')).toBe(mimeFor('geojson'));
    expect(mimeFor('geojson')).toBe('application/geo+json');
  });

  it('knows every submitted format', () => {
    for (const ext of ['geojson', 'json', 'kml', 'kmz', 'gpx', 'tcx', 'parquet']) {
      expect(mimeFor(ext), ext).not.toBe('application/octet-stream');
    }
  });

  it('falls back to octet-stream for anything else', () => {
    expect(mimeFor('exe')).toBe('application/octet-stream');
    expect(mimeFor('toString')).toBe('application/octet-stream');
  });
});

describe('/c page JSON-LD', () => {
  const submission = (format: string): SubmissionView => ({
    id: 'rT0I6Kgo9X', created_at: '2026-05-20T10:00:00.000Z', updated_at: null, status: 'accepted',
    name: 'X', description: 'X', category: 'infrastructure', license: 'CC-BY-4.0', attribution: 'X',
    source_url: null, is_original: 1, format, bytes: 1024, feature_count: 1, geometry_types: 'Point',
    r2_key: `community/rT0I6Kgo9X/file.${format}`,
  } as SubmissionView);

  it('describes each download with the same MIME type the file is stored with', () => {
    for (const format of ['parquet', 'json', 'gpx']) {
      const html = renderViewPage({ submission: submission(format), ratingsCount: 0 });
      expect(html, format).toContain(`"encodingFormat":"${mimeFor(format)}"`);
    }
  });
});
