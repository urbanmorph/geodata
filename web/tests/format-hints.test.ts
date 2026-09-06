import { describe, it, expect } from 'vitest';
import { availableDownloads, formatLabel, formatHint, fmtBytes, fmtCount } from '../src/format-hints';

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

  it('surfaces baked kml + shapefile when present, in stable order after geojson', () => {
    const layer = {
      shapefile: { url: 's.shp.zip', bytes: 4 },
      kml: { url: 'k.kml', bytes: 5 },
      parquet: { url: 'p.parquet', bytes: 1 },
      pmtiles: { url: 't.pmtiles', bytes: 2 },
      geojson: { url: 'g.json', bytes: 3 },
    };
    const out = availableDownloads(layer);
    expect(out.map((d) => d.fmt)).toEqual(['parquet', 'pmtiles', 'geojson', 'kml', 'shapefile']);
  });

  it('omits kml + shapefile when not baked (null) — bake-not-yet-run is graceful', () => {
    const layer = {
      parquet: { url: 'p', bytes: 1 },
      pmtiles: { url: 't', bytes: 2 },
      kml: null,
      shapefile: null,
    };
    const out = availableDownloads(layer);
    expect(out.map((d) => d.fmt)).toEqual(['parquet', 'pmtiles']);
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
    expect(formatLabel('shapefile')).toBe('Shapefile');
  });

  it('hints mention the canonical use case', () => {
    expect(formatHint('parquet')).toMatch(/DuckDB|pandas|R/);
    expect(formatHint('pmtiles')).toMatch(/vector tiles|MapLibre/);
    expect(formatHint('geojson')).toMatch(/QGIS|web|Earth/);
    expect(formatHint('kml')).toMatch(/Google Earth/);
    expect(formatHint('shapefile')).toMatch(/QGIS|ArcGIS|\.shp/);
  });
});

describe('format-hints — fmtBytes', () => {
  it('formats null as em-dash', () => expect(fmtBytes(null)).toBe('—'));
  it('formats < 1 KB in bytes', () => expect(fmtBytes(512)).toBe('512 B'));
  it('formats KB without decimals', () => expect(fmtBytes(2048)).toBe('2 KB'));
  it('formats MB with one decimal', () => expect(fmtBytes(2.5 * 1024 * 1024)).toBe('2.5 MB'));
  it('formats GB with two decimals', () => expect(fmtBytes(3.14 * 1024 ** 3)).toBe('3.14 GB'));
});

describe('format-hints — fmtCount', () => {
  it('shows small counts raw', () => {
    expect(fmtCount(0)).toBe('0');
    expect(fmtCount(948)).toBe('948');
    expect(fmtCount(999)).toBe('999');
  });
  it('uses one decimal in the k range, dropping a trailing .0', () => {
    expect(fmtCount(1000)).toBe('1k');
    expect(fmtCount(9300)).toBe('9.3k');
  });
  it('keeps the decimal past 10k (the regression: 10.3k, not 10k)', () => {
    expect(fmtCount(10300)).toBe('10.3k');
    expect(fmtCount(10000)).toBe('10k');
    expect(fmtCount(99900)).toBe('99.9k');
  });
  it('drops to whole thousands at 100k and above (avoids 250.4k noise)', () => {
    expect(fmtCount(100000)).toBe('100k');
    expect(fmtCount(250400)).toBe('250k');
    expect(fmtCount(999499)).toBe('999k');
  });
  it('rolls over to millions with one decimal', () => {
    expect(fmtCount(1000000)).toBe('1M');
    expect(fmtCount(1200000)).toBe('1.2M');
  });
});
