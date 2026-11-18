-- API and MCP calls per layer per UTC day (functions/lib/usage.ts), written in
-- the same batch as api_usage, so ops can show the last 30 days like every
-- other app. Counts only: no caller data (IP, User-Agent) is stored.
CREATE TABLE IF NOT EXISTS api_usage_daily (
  day       TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  layer_id  TEXT NOT NULL,
  channel   TEXT NOT NULL,              -- api | mcp
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, layer_id, channel)
);
