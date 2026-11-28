-- Layer requests (docs#request): someone asks for a layer bharatlas does not have. We check it can be done
-- (an open source that allows any use: a requested layer is paid work, never non-commercial), then the owner
-- emails to arrange Rs 499 by UPI; nothing is paid on the site. The email is for that reply only and is never
-- shown; credit_name is what "Requested by" shows (blank: anonymous).
CREATE TABLE IF NOT EXISTS layer_requests (
  id          TEXT PRIMARY KEY,                 -- 'req_<10 chars>', shown to the requester as their reference
  created_at  TEXT NOT NULL,
  what        TEXT NOT NULL,
  place       TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  credit_name TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL,
  query       TEXT NOT NULL DEFAULT '',         -- the search that found nothing, when the request came from one
  status      TEXT NOT NULL DEFAULT 'new',      -- new | feasible | not_feasible | paid | published
  ip_hash     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS layer_requests_status ON layer_requests (status, created_at);
