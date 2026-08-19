-- collect programmatic-abuse gate. An MCP / REST caller has no browser Turnstile,
-- so collection creation over the API is gated by an API key instead: minted
-- out-of-band by a maintainer (scripts/mint_collect_api_key.py), stored hash-only
-- (plaintext shown once), rate-limited per key (daily_limit). Everything else in
-- the API is already token-scoped, so only create needs this.
CREATE TABLE IF NOT EXISTS collect_api_keys (
  id          TEXT PRIMARY KEY,
  key_prefix  TEXT NOT NULL,           -- first 8 chars, for lookup
  key_hash    TEXT NOT NULL,           -- sha256 of the full key; plaintext never stored
  label       TEXT,                    -- who/what it's for
  daily_limit INTEGER NOT NULL DEFAULT 50,
  created_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_collect_api_keys_prefix ON collect_api_keys(key_prefix);
