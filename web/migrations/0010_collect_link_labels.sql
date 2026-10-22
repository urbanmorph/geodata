-- collect: labelled links + which link added each record (additive only).
--
-- An admin can mint a named collect/view link ("Ward 12 team", "Asha") and
-- turn one off without changing anyone else's link. Each record remembers the
-- collection_tokens row that submitted it, so the admin can see "via Asha".
-- Still no identity: a link is a capability, not a person.
--
-- Both columns are nullable. Rows written before this migration, imported
-- rows (provenance is records.source), and links minted without a label keep
-- NULL. Apply BEFORE deploying the collect code that writes token_id.

ALTER TABLE collection_tokens ADD COLUMN label TEXT;     -- admin's name for the link; NULL = unlabelled
ALTER TABLE records ADD COLUMN token_id TEXT;            -- collection_tokens.id that added it; NULL = legacy/imported

CREATE INDEX IF NOT EXISTS idx_rec_coll_token ON records (collection_id, token_id);
