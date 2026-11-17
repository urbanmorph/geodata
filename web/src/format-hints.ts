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

type LayerLike = {
  parquet?: { url: string; bytes: number | null } | null;
  pmtiles?: { url: string; bytes: number | null } | null;
  geojson?: { url: string; bytes: number | null } | null;
  kml?: { url: string; bytes: number | null } | null;
  shapefile?: { url: string; bytes: number | null } | null;
};

const HINTS: Record<DownloadFormat, { label: string; hint: string }> = {
  parquet:   { label: 'Parquet',   hint: 'analytics · DuckDB, pandas, R' },
  pmtiles:   { label: 'PMTiles',   hint: 'vector tiles · MapLibre, web maps' },
  geojson:   { label: 'GeoJSON',   hint: 'web maps, QGIS, Earth' },
  kml:       { label: 'KML',       hint: 'Google Earth, Google My Maps' },
  shapefile: { label: 'Shapefile', hint: 'QGIS, ArcGIS · .shp + .dbf + .shx zipped' },
};

export function availableDownloads(layer: LayerLike): DownloadEntry[] {
  const out: DownloadEntry[] = [];
  if (layer.parquet?.url) {
    out.push({ fmt: 'parquet', ...HINTS.parquet, url: dlProxyUrl(layer.parquet.url, 'parquet'), bytes: layer.parquet.bytes });
  }
  if (layer.pmtiles?.url) {
    out.push({ fmt: 'pmtiles', ...HINTS.pmtiles, url: dlProxyUrl(layer.pmtiles.url, 'pmtiles'), bytes: layer.pmtiles.bytes });
  }
  if (layer.geojson?.url) {
    out.push({ fmt: 'geojson', ...HINTS.geojson, url: dlProxyUrl(layer.geojson.url, 'geojson'), bytes: layer.geojson.bytes });
  }
  if (layer.kml?.url) {
    out.push({ fmt: 'kml', ...HINTS.kml, url: dlProxyUrl(layer.kml.url, 'kml'), bytes: layer.kml.bytes });
  }
  if (layer.shapefile?.url) {
    out.push({ fmt: 'shapefile', ...HINTS.shapefile, url: dlProxyUrl(layer.shapefile.url, 'shapefile'), bytes: layer.shapefile.bytes });
  }
  return out;
}

export { fmtBytes, fmtCount } from '../../shared/format.mjs';

// Compact count for download badges + the search-meta total. One decimal while
// it reads cleanly (9.3k, 10.3k, 99.9k), whole thousands once that decimal is
// just noise (250k), then millions (1.2M). A trailing .0 is always dropped.
// Previously anything >= 10k rounded to whole thousands, so 10,300 showed as
// "10k" — this keeps the tenths that make the number feel live.
