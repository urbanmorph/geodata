-- Per-file download counts and per-IP thumbs-up ratings.

CREATE TABLE IF NOT EXISTS download_counts (
  layer_id    TEXT NOT NULL,              -- 'lgd_villages' for curated, 'c_<id>' for community
  state_code  TEXT NOT NULL DEFAULT '',   -- '29' for KA, '' for pan-India / non-state-filtered
  format      TEXT NOT NULL,              -- parquet | geojson | kml | pmtiles
  count       INTEGER NOT NULL DEFAULT 0,
  last_at     TEXT,
  PRIMARY KEY (layer_id, state_code, format)
);

CREATE TABLE IF NOT EXISTS submission_ratings (
  submission_id TEXT NOT NULL,
  ip_hash       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (submission_id, ip_hash),
  FOREIGN KEY (submission_id) REFERENCES submissions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ratings_sub ON submission_ratings (submission_id);
