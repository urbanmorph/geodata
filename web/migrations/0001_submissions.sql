-- Submissions, tokens, rate-limit windows.
-- IDs are 10-char nanoid (URL-safe alphabet).
-- All timestamps are ISO-8601 UTC.

CREATE TABLE IF NOT EXISTS submissions (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'retracted')),

  name            TEXT NOT NULL,
  description     TEXT,
  category        TEXT NOT NULL,             -- administrative | people | environment | infrastructure | health-edu | other
  license         TEXT NOT NULL,             -- one of OPEN_LICENCES (see lib/licenses.ts)
  attribution     TEXT NOT NULL,             -- credit line, 3..200 chars
  source_url      TEXT NOT NULL,

  format          TEXT NOT NULL,             -- geojson | kml | kmz | parquet
  bytes           INTEGER NOT NULL,
  feature_count   INTEGER,
  geometry_types  TEXT,                       -- e.g. "Polygon,MultiPolygon"
  content_hash    TEXT,                       -- SHA-256 hex; used for dedupe

  ip_hash         TEXT NOT NULL,              -- SHA-256(IP || daily salt)
  validation_report TEXT,                     -- JSON of checks + results
  rejection_reason TEXT,

  r2_key          TEXT NOT NULL               -- e.g. community/<id>/<filename>
);

CREATE INDEX IF NOT EXISTS idx_subs_status_created ON submissions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subs_content_hash   ON submissions (content_hash);

-- Anonymous admin/edit/view tokens — token plaintext is never stored,
-- only its prefix (for O(1) lookup) + sha256 hash (for constant-time verify).
CREATE TABLE IF NOT EXISTS submission_tokens (
  id              TEXT PRIMARY KEY,           -- internal token row id
  submission_id   TEXT NOT NULL,
  token_prefix    TEXT NOT NULL,              -- first 8 chars of the token (e.g. "adm_xxxx")
  token_hash      TEXT NOT NULL,              -- sha256 hex of full token
  permission      TEXT NOT NULL CHECK (permission IN ('admin','edit','view')),
  is_active       INTEGER NOT NULL DEFAULT 1,
  expires_at      TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (submission_id) REFERENCES submissions (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tokens_prefix ON submission_tokens (token_prefix);
CREATE INDEX IF NOT EXISTS idx_tokens_sub    ON submission_tokens (submission_id);

-- Sliding-window counters per hashed IP. One row per IP; updated atomically.
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash         TEXT PRIMARY KEY,
  hour_window_start TEXT NOT NULL,
  hour_count      INTEGER NOT NULL DEFAULT 0,
  day_window_start TEXT NOT NULL,
  day_count       INTEGER NOT NULL DEFAULT 0
);
