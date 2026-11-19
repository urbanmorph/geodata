-- collect: the owner's list of every record on a map (all statuses), newest
-- first with id as the tie-break (functions/lib/db.ts listRecords). The existing
-- (collection_id, status, created_at) index serves one status; without this one
-- each page of the all-status list sorted the whole map.
CREATE INDEX IF NOT EXISTS idx_rec_coll_created ON records (collection_id, created_at DESC, id DESC);
