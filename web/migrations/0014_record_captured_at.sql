-- collect: when a point was captured on the phone (additive only).
--
-- records.created_at is when the server saved it. A point saved offline is sent
-- later, so created_at is when the phone got signal back, not when the
-- contributor stood there. The phone now sends its capture time; the server
-- keeps it when plausible (not in the future, under a year old).
--
-- Nullable: earlier rows, imports, and callers that send no capture time keep
-- NULL, and readers fall back to created_at. Apply BEFORE deploying the collect
-- code that writes it.

ALTER TABLE records ADD COLUMN captured_at TEXT;  -- ISO time from the phone; NULL = use created_at
