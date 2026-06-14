-- Funnel instrumentation: record the outcome of every /api/submit POST.
-- Hard-rejected attempts are bounced at validation before the submissions
-- insert, so without this they leave no trace and the funnel past /submit is
-- a black box. Stores only the failing gate + coarse file facts — no file
-- bytes, no name / attribution / source text.

CREATE TABLE IF NOT EXISTS submit_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  outcome     TEXT NOT NULL,   -- 'accepted' | 'rejected'
  gate        TEXT,            -- failing gate: captcha|rateLimit|size|filename|format|name|license|attribution|sourceUrl|crs|geometry|parse|persist (NULL when accepted)
  reason      TEXT,            -- human reason string (NULL when accepted)
  ext         TEXT,            -- file extension
  bytes       INTEGER,         -- file size
  ip_hash     TEXT             -- already-hashed IP (matches submissions/rate_limits)
);
CREATE INDEX IF NOT EXISTS idx_attempts_created ON submit_attempts (created_at);
CREATE INDEX IF NOT EXISTS idx_attempts_gate ON submit_attempts (gate);
