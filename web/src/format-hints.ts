// Per-format download metadata for the map-view download menu.
// Pure: no DOM, no DuckDB. Consumed by map.ts to build the popover.
// Data files link through the /api/dl counter (shared/downloads.mjs), as on /layers.
import { dlProxyUrl } from '../../shared/downloads.mjs';

export type DownloadFormat = 'parquet' | 'pmtiles' | 'geojson' | 'kml' | 'shapefile';

export type DownloadEntry = {
  fmt: DownloadFormat;
  label: string;
  hint: string;
  url: string;
  bytes: number | null;
};

type LayerLike = Partial<Record<DownloadFormat, { url: string; bytes: number | null } | null>>;

const HINTS: Record<DownloadFormat, { label: string; hint: string }> = {
  parquet:   { label: 'Parquet',   hint: 'analytics · DuckDB, pandas, R' },
  pmtiles:   { label: 'PMTiles',   hint: 'vector tiles · MapLibre, web maps' },
  geojson:   { label: 'GeoJSON',   hint: 'web maps, QGIS, Earth' },
  kml:       { label: 'KML',       hint: 'Google Earth, Google My Maps' },
  shapefile: { label: 'Shapefile', hint: 'QGIS, ArcGIS · .shp + .dbf + .shx zipped' },
};

// HINTS' key order is the menu order.
export function availableDownloads(layer: LayerLike): DownloadEntry[] {
  return (Object.keys(HINTS) as DownloadFormat[]).flatMap((fmt) => {
    const file = layer[fmt];
    return file?.url ? [{ fmt, ...HINTS[fmt], url: dlProxyUrl(file.url, fmt), bytes: file.bytes }] : [];
  });
}

export { fmtBytes, fmtCount } from '../../shared/format.mjs';
