// Bindings for the collect Pages project (collect/wrangler.toml). D1 + R2 are
// the SAME shared resources web binds; the origin differs, the data is shared.

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  TURNSTILE_SECRET?: string;
  PUBLIC_TURNSTILE_SITEKEY?: string;
  IP_SALT?: string;
  // Origin for locate enrichment (defaults to https://bharatlas.com); override
  // in tests to point at a stub. Phase 4.
  LOCATE_ORIGIN?: string;
  // Workers AI: notes from photos. Absent (local dev without a remote binding)
  // = notes wait. AI_DAILY_PHOTOS caps photos sent per day (default 600, inside
  // the free allowance); AI_MODEL overrides the model (see functions/lib/ai.ts).
  AI?: Ai;
  AI_DAILY_PHOTOS?: string;
  AI_DAILY_PER_MAP?: string; // each map's share of the day (default 200)
  AI_MODEL?: string;
}
