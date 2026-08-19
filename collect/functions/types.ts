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
}
