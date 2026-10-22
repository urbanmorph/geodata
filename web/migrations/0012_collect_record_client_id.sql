-- collect: offline capture queue, so a point sent twice is saved once (additive only).
--
-- A phone with a weak signal may send the same queued point again: the first
-- send saved, but the reply was lost. Each queued point carries a random
-- client_id; the server keeps only its SHA-256 here and treats a repeat on the
-- same map as the same record (returning it, with a fresh edit token).
--
-- Nullable: earlier rows, imports and callers without client_id (the bharatlas
-- MCP, older clients) keep NULL and are never matched. The partial unique index
-- turns a race between two concurrent repeats into a constraint error the
-- handler resolves. Apply BEFORE deploying the collect code that writes it.

ALTER TABLE records ADD COLUMN client_key_hash TEXT;  -- SHA-256 of the queued point's client_id; NULL = not queued

CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_client_key
  ON records (collection_id, client_key_hash) WHERE client_key_hash IS NOT NULL;
