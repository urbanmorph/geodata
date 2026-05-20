-- v3.1.1: convert thumbs-up rating into Reddit-style up/down voting.
-- Existing rows are treated as upvotes (vote=1) — the model never had
-- downvotes before this migration.
ALTER TABLE submission_ratings ADD COLUMN vote INTEGER NOT NULL DEFAULT 1
  CHECK (vote IN (-1, 1));
