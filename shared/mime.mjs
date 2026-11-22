// One table of file format (its extension) -> MIME type, for the R2
// content-type a new upload is stored with and the encodingFormat its page's
// JSON-LD declares. Parquet is the IANA-registered application/vnd.apache.parquet.
// A submitted .json is a GeoJSON FeatureCollection, so it is geo+json too.
// scripts/pipeline.py CONTENT_TYPES uses the same values for curated layers.

export const FORMAT_MIME = Object.freeze({
  parquet: 'application/vnd.apache.parquet',
  pmtiles: 'application/vnd.pmtiles',
  geojson: 'application/geo+json',
  json: 'application/geo+json',
  kml: 'application/vnd.google-earth.kml+xml',
  kmz: 'application/vnd.google-earth.kmz',
  gpx: 'application/gpx+xml',
  tcx: 'application/vnd.garmin.tcx+xml',
  csv: 'text/csv; charset=utf-8',
  zip: 'application/zip',
});

/** The MIME type for a format; application/octet-stream when it has none. */
export function mimeFor(format) {
  return Object.prototype.hasOwnProperty.call(FORMAT_MIME, format) ? FORMAT_MIME[format] : 'application/octet-stream';
}
