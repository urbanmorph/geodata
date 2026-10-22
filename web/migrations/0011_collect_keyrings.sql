-- collect: end-to-end encrypted "keyring" sync (opt-in, no accounts).
--
-- A keyring is the device's list of map links + record edit links, encrypted
-- in the browser with a key derived from a random secret that only the user
-- holds (it rides the fragment of their sync link, never the server). This
-- table stores the ciphertext only: the server can't read it and can't tell
-- whose it is.
--   id          derived from the secret (HKDF), 32 hex chars; not the secret
--   write_hash  SHA-256 of the write key (also derived); gates update/delete
--   blob        base64url(iv || AES-GCM ciphertext), <= 256 KB
--   used_at     last read or write; rows unused for 12 months are deleted
--               (opportunistically on writes; see spec-collect retention table)

CREATE TABLE IF NOT EXISTS collect_keyrings (
  id          TEXT PRIMARY KEY,
  write_hash  TEXT NOT NULL,
  blob        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  used_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_keyrings_used ON collect_keyrings (used_at);
