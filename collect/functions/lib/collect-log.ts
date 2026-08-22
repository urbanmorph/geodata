// Funnel instrumentation: outcome of every create / contribute / publish
// attempt (spec → Deployment checklist item 8). Coarse facts only — no field
// values, no names. Best-effort; never blocks the request.

import type { D1Database } from '@cloudflare/workers-types';

export type CollectEvent = 'create' | 'contribute' | 'publish' | 'import';

export interface CollectAttempt {
  event: CollectEvent;
  outcome: 'ok' | 'rejected';
  gate?: string | null;
  reason?: string | null;
  collection_id?: string | null;
  ip_hash?: string | null;
}

export async function logCollectAttempt(db: D1Database, row: CollectAttempt): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO collect_attempts (event, outcome, gate, reason, collection_id, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.event, row.outcome, row.gate ?? null, row.reason ?? null, row.collection_id ?? null, row.ip_hash ?? null)
      .run();
  } catch {
    // instrumentation must never break a request
  }
}

// Register the async log with ctx.waitUntil (via the handler's `defer`) so the
// D1 write survives the response. A bare `void logCollectAttempt(...)` is a
// dangling promise the Workers runtime cancels once the Response is returned,
// which is why collect_attempts stayed empty. `defer` keeps the request alive
// until the write lands; without it we fall back to best-effort (never blocks).
export function deferLog(
  defer: ((p: Promise<unknown>) => void) | undefined,
  db: D1Database,
  row: CollectAttempt,
): void {
  const p = logCollectAttempt(db, row);
  if (defer) defer(p);
  else void p;
}
