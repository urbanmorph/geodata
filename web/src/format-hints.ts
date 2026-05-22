// Per-format download metadata for the map-view download menu.
// Pure: no DOM, no DuckDB. Consumed by map.ts to build the popover.

export type DownloadFormat = 'parquet' | 'pmtiles' | 'geojson' | 'kml';

export type DownloadEntry = {
  fmt: DownloadFormat;
  label: string;
  hint: string;
  url: string;
  bytes: number | null;
};

type LayerLike = {
  parquet?: { url: string; bytes: number | null } | null;
  pmtiles?: { url: string; bytes: number | null } | null;
  geojson?: { url: string; bytes: number | null } | null;
};

const HINTS: Record<DownloadFormat, { label: string; hint: string }> = {
  parquet: { label: 'Parquet', hint: 'analytics · DuckDB, pandas, R' },
  pmtiles: { label: 'PMTiles', hint: 'vector tiles · MapLibre, web maps' },
  geojson: { label: 'GeoJSON', hint: 'web maps, QGIS, Earth' },
  kml:     { label: 'KML',     hint: 'Google Earth, Google My Maps' },
};

export function formatLabel(fmt: DownloadFormat): string {
  return HINTS[fmt].label;
}

export function formatHint(fmt: DownloadFormat): string {
  return HINTS[fmt].hint;
}

export function availableDownloads(layer: LayerLike): DownloadEntry[] {
  const out: DownloadEntry[] = [];
  if (layer.parquet?.url) {
    out.push({ fmt: 'parquet', ...HINTS.parquet, url: layer.parquet.url, bytes: layer.parquet.bytes });
  }
  if (layer.pmtiles?.url) {
    out.push({ fmt: 'pmtiles', ...HINTS.pmtiles, url: layer.pmtiles.url, bytes: layer.pmtiles.bytes });
  }
  if (layer.geojson?.url) {
    out.push({ fmt: 'geojson', ...HINTS.geojson, url: layer.geojson.url, bytes: layer.geojson.bytes });
  }
  return out;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
