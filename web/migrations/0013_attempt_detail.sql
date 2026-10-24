-- Every submit / publish attempt must explain itself. A failed save in Oct
-- 2026 left only "failed to persist submission": no reference to match the
-- contributor's report, no step, no error text. These columns record the
-- reference shown to the contributor, the submission created (if any), the
-- step that failed, the exact error, how long it took and what was cleaned up.

ALTER TABLE submit_attempts ADD COLUMN attempt_id TEXT;
ALTER TABLE submit_attempts ADD COLUMN submission_id TEXT;
ALTER TABLE submit_attempts ADD COLUMN step TEXT;
ALTER TABLE submit_attempts ADD COLUMN detail TEXT;
ALTER TABLE submit_attempts ADD COLUMN duration_ms INTEGER;
ALTER TABLE submit_attempts ADD COLUMN cleanup TEXT;
CREATE INDEX IF NOT EXISTS idx_attempts_attempt ON submit_attempts (attempt_id);

ALTER TABLE collect_attempts ADD COLUMN attempt_id TEXT;
ALTER TABLE collect_attempts ADD COLUMN submission_id TEXT;
ALTER TABLE collect_attempts ADD COLUMN step TEXT;
ALTER TABLE collect_attempts ADD COLUMN detail TEXT;
ALTER TABLE collect_attempts ADD COLUMN duration_ms INTEGER;
ALTER TABLE collect_attempts ADD COLUMN cleanup TEXT;
CREATE INDEX IF NOT EXISTS idx_collatt_attempt ON collect_attempts (attempt_id);
