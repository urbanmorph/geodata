import { describe, it, expect } from 'vitest';
import { availableDownloads, formatLabel, formatHint, fmtBytes } from '../src/format-hints';

describe('format-hints — availableDownloads', () => {
  it('returns empty list for a layer with nothing downloadable', () => {
    expect(availableDownloads({})).toEqual([]);
  });

  it('returns one entry per available format, in stable order parquet→pmtiles→geojson', () => {
    const layer = {
      geojson: { url: 'g.json', bytes: 1 },
      parquet: { url: 'p.parquet', bytes: 2 },
      pmtiles: { url: 't.pmtiles', bytes: 3 },
    };
    const out = availableDownloads(layer);
    expect(out.map((d) => d.fmt)).toEqual(['parquet', 'pmtiles', 'geojson']);
  });

  it('preserves bytes (including null) and url verbatim', () => {
    const out = availableDownloads({
      parquet: { url: 'https://r2/x.parquet', bytes: null },
      pmtiles: { url: 'https://r2/x.pmtiles', bytes: 12345 },
    });
    expect(out[0]).toMatchObject({ url: 'https://r2/x.parquet', bytes: null });
    expect(out[1]).toMatchObject({ url: 'https://r2/x.pmtiles', bytes: 12345 });
  });

  it('skips a format if url is missing', () => {
    // Defensive: catalog has sometimes shipped null-stubbed format keys.
    const out = availableDownloads({
      parquet: null,
      pmtiles: { url: 't.pmtiles', bytes: 1 },
    });
    expect(out).toHaveLength(1);
    expect(out[0].fmt).toBe('pmtiles');
  });

  it('every entry carries a non-empty hint and label', () => {
    const out = availableDownloads({
      parquet: { url: 'p', bytes: 1 },
      pmtiles: { url: 't', bytes: 1 },
      geojson: { url: 'g', bytes: 1 },
    });
    for (const d of out) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('format-hints — labels + hints', () => {
  it('labels are human-readable', () => {
    expect(formatLabel('parquet')).toBe('Parquet');
    expect(formatLabel('pmtiles')).toBe('PMTiles');
    expect(formatLabel('geojson')).toBe('GeoJSON');
    expect(formatLabel('kml')).toBe('KML');
  });

  it('hints mention the canonical use case', () => {
    expect(formatHint('parquet')).toMatch(/DuckDB|pandas|R/);
    expect(formatHint('pmtiles')).toMatch(/vector tiles|MapLibre/);
    expect(formatHint('geojson')).toMatch(/QGIS|web|Earth/);
    expect(formatHint('kml')).toMatch(/Google Earth/);
  });
});

describe('format-hints — fmtBytes', () => {
  it('formats null as em-dash', () => expect(fmtBytes(null)).toBe('—'));
  it('formats < 1 KB in bytes', () => expect(fmtBytes(512)).toBe('512 B'));
  it('formats KB without decimals', () => expect(fmtBytes(2048)).toBe('2 KB'));
  it('formats MB with one decimal', () => expect(fmtBytes(2.5 * 1024 * 1024)).toBe('2.5 MB'));
  it('formats GB with two decimals', () => expect(fmtBytes(3.14 * 1024 ** 3)).toBe('3.14 GB'));
});
