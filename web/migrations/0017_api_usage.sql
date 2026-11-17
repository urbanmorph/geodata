-- API and MCP calls per layer (functions/lib/usage.ts): proof of use beside
-- download_counts. Only calls that name a layer are counted.
CREATE TABLE IF NOT EXISTS api_usage (
  layer_id  TEXT NOT NULL,
  channel   TEXT NOT NULL,              -- api | mcp
  count     INTEGER NOT NULL DEFAULT 0,
  last_at   TEXT,
  PRIMARY KEY (layer_id, channel)
);
