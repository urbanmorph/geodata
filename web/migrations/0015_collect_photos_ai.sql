-- collect: photos on points, and notes a model writes from them (additive only).
--
-- collect_photos: one row per uploaded photo. The JPEG lives in R2 at r2_key
-- (resized on the phone, only its place and time kept). A photo is uploaded
-- before its point is saved, so record_id starts NULL and is set when a point
-- claims it; unclaimed photos older than a day are deleted. client_key_hash
-- (SHA-256 of the phone's id for the photo) makes a repeated upload return the
-- same photo. lat/lng/taken_at are what the camera recorded; source is
-- 'camera' or 'gallery'.
--
-- records.ai: JSON of the model's notes for a point (status, model, description,
-- tags, suggested answers, and whether a person accepted or discarded them).
-- NULL = the map doesn't use AI notes, or the point has no photo.
--
-- collect_ai_usage: photos sent to the model per UTC day, so the free daily
-- allowance is never exceeded (the rest wait for the next day).
--
-- Apply BEFORE deploying the collect code that writes them.

CREATE TABLE IF NOT EXISTS collect_photos (
  id              TEXT PRIMARY KEY,           -- ph_<random>
  collection_id   TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  record_id       TEXT,                       -- NULL until a point claims it
  r2_key          TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  lat             REAL,
  lng             REAL,
  taken_at        TEXT,
  source          TEXT,                       -- camera | gallery
  client_key_hash TEXT,
  ip_hash         TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photo_record ON collect_photos (record_id);
CREATE INDEX IF NOT EXISTS idx_photo_orphans ON collect_photos (collection_id, created_at) WHERE record_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_photo_client_key
  ON collect_photos (collection_id, client_key_hash) WHERE client_key_hash IS NOT NULL;

ALTER TABLE records ADD COLUMN ai TEXT;       -- JSON notes from the model; NULL = none

CREATE TABLE IF NOT EXISTS collect_ai_usage (
  day   TEXT PRIMARY KEY,                     -- YYYY-MM-DD (UTC)
  calls INTEGER NOT NULL DEFAULT 0
);
