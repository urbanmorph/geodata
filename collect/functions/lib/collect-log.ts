// Funnel instrumentation: outcome of every create / contribute / publish
// attempt (spec → Deployment checklist item 8). Coarse facts only — no field
// values, no names. Best-effort; never blocks the request.

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
