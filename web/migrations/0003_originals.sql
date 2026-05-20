-- v3.1.1: original-creator path.
-- is_original=1 means the contributor IS the source (hand-drawn, surveyed,
-- compiled). source_url becomes optional 'method' text for these — same
-- column, semantics depend on this flag. View page renders accordingly.

ALTER TABLE submissions ADD COLUMN is_original INTEGER NOT NULL DEFAULT 0;
