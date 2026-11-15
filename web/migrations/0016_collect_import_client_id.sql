-- collect: bulk import is idempotent per row (additive only).
--
-- An importer may tag each imported row with its own id for it (a hospital
-- code, a survey row number): `client_id` on POST /collections/:id/import. A
-- re-run of the same file then adds nothing, and a re-run with corrected rows
-- updates those rows in place. Scoped per map; at most 128 characters.
--
-- Kept apart from client_key_hash (the offline queue's secret client_id, whose
-- holder may re-claim the record's edit token): an import id is a public
-- identifier and must never unlock a record.
--
-- Nullable: earlier rows, field captures and imports without client_id keep
-- NULL and are never matched (re-importing those adds them again). The partial
-- unique index is the conflict target of the import's INSERT ... ON CONFLICT
-- upsert. Apply BEFORE deploying the collect code that writes it.

ALTER TABLE records ADD COLUMN import_client_id TEXT;  -- the importer's id for this row; NULL = not imported with one

CREATE UNIQUE INDEX IF NOT EXISTS idx_rec_import_client_id
  ON records (collection_id, import_client_id) WHERE import_client_id IS NOT NULL;
