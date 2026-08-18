-- collect.bharatlas.com — collections, their tokens, contributed records,
-- catalogue publications, and funnel instrumentation.
--
-- IDs are 10-char nanoid (matching submissions). All timestamps ISO-8601 UTC.
-- Shares the geodata-submissions D1 with web (bound as DB on both projects).
--
-- Design notes (see supporting-docs/spec-collect.md):
--   * geometry types live in schema_doc."geometry" — there is no geometry_types column.
--   * the credit line is composed at publish from name + contributor count —
--     there is no attribution column here.
--   * counts (total / pending / published) are computed on read via GROUP BY —
--     there are no denormalised counter columns.

-- A collection project: a schema, and the records contributed against it.
CREATE TABLE IF NOT EXISTS collections (
  id              TEXT PRIMARY KEY,           -- 10-char nanoid
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'closed')),

  name            TEXT NOT NULL,              -- 3..120
  description     TEXT,
  data_year       INTEGER,                    -- optional: year the data represents; layer vintage at publish
  purpose         TEXT NOT NULL,              -- why data is collected; shown to contributors (DPDP notice)

  schema_doc      TEXT NOT NULL,              -- JSON field definition; its "geometry" array is the
                                              -- single source of truth for allowed geometry types
  license         TEXT NOT NULL,              -- OPEN_LICENCES id only (isOpenLicence), fixed at creation
  moderation      INTEGER NOT NULL DEFAULT 1, -- 1 = records start pending

  ip_hash         TEXT NOT NULL               -- SHA-256(IP || daily salt)
);
CREATE INDEX IF NOT EXISTS idx_coll_status_created ON collections (status, created_at DESC);

-- Anonymous admin/edit/view tokens for one collection. Plaintext never stored:
-- only the prefix (O(1) lookup) + sha256 hash (constant-time verify).
CREATE TABLE IF NOT EXISTS collection_tokens (
  id              TEXT PRIMARY KEY,
  collection_id   TEXT NOT NULL,
  token_prefix    TEXT NOT NULL,
  token_hash      TEXT NOT NULL,
  permission      TEXT NOT NULL CHECK (permission IN ('admin','edit','view')),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES collections (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ctok_prefix ON collection_tokens (token_prefix);
CREATE INDEX IF NOT EXISTS idx_ctok_coll   ON collection_tokens (collection_id);

-- One contribution (marker) against a collection.
CREATE TABLE IF NOT EXISTS records (
  id              TEXT PRIMARY KEY,
  collection_id   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','published','rejected')),

  geometry        TEXT NOT NULL,              -- GeoJSON geometry, India-bounded
  properties      TEXT NOT NULL DEFAULT '{}', -- JSON keyed by schema field key
  admin_ctx       TEXT,                       -- JSON from locate: state/district/ward/…

  contributor     TEXT,                       -- self-declared, opt-in; NULL = anonymous
  edit_token_hash TEXT,                       -- sha256 of the record's rec_ token (edit/delete/de-identify)
  ip_hash         TEXT NOT NULL,
  rejection_reason TEXT,

  FOREIGN KEY (collection_id) REFERENCES collections (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_rec_coll_status ON records (collection_id, status, created_at DESC);

-- An immutable snapshot pushed to the catalogue (one row per published version).
CREATE TABLE IF NOT EXISTS publications (
  id              TEXT PRIMARY KEY,
  collection_id   TEXT NOT NULL,
  version         INTEGER NOT NULL,           -- 1, 2, 3, …
  submission_id   TEXT NOT NULL,              -- the submissions row this version produced
  published_at    TEXT NOT NULL,
  feature_count   INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  attribution_snapshot TEXT NOT NULL,         -- composed credit line at publish time
  r2_key          TEXT NOT NULL,
  FOREIGN KEY (collection_id) REFERENCES collections (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pub_coll_ver ON publications (collection_id, version);

-- Link a submission back to the collection + version that produced it.
ALTER TABLE submissions ADD COLUMN collection_id TEXT;
ALTER TABLE submissions ADD COLUMN collection_version INTEGER;

-- Funnel instrumentation: outcome of every create / contribute / publish
-- attempt, mirroring submit_attempts. Coarse facts only — no field values,
-- no names. Lets us measure the create→contribute→publish funnel that is the
-- whole reason collect exists.
CREATE TABLE IF NOT EXISTS collect_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  event         TEXT NOT NULL,   -- 'create' | 'contribute' | 'publish'
  outcome       TEXT NOT NULL,   -- 'ok' | 'rejected'
  gate          TEXT,            -- failing gate on rejection (captcha|rateLimit|schema|bounds|geometry|persist|…)
  reason        TEXT,            -- human reason string (NULL when ok)
  collection_id TEXT,            -- when known
  ip_hash       TEXT             -- already-hashed IP
);
CREATE INDEX IF NOT EXISTS idx_collatt_created ON collect_attempts (created_at);
CREATE INDEX IF NOT EXISTS idx_collatt_event   ON collect_attempts (event);
