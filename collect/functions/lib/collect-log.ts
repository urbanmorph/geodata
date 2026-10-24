// Funnel instrumentation: outcome of every create / contribute / publish
// attempt (spec → Deployment checklist item 8). Coarse facts only — no field
// values, no names — plus, for failures, the reference, step and exact error.
// Never blocks the request.

import type { D1Database } from '@cloudflare/workers-types';
// Imported directly (not via ./reuse): reuse also loads the submission libs,
// which need Cloudflare's ambient types that collect's browser tests lack.
import { insertAttempt, type AttemptDetail } from '../../../web/functions/lib/attempt-log';

export type CollectEvent = 'create' | 'contribute' | 'publish' | 'import' | 'edit_form';

export interface CollectAttempt extends AttemptDetail {
  event: CollectEvent;
  outcome: 'ok' | 'rejected';
  gate?: string | null;
  reason?: string | null;
  collection_id?: string | null;
  ip_hash?: string | null;
}

/** Record one collect attempt (reference, step, exact error, timing and
 *  cleanup included; see insertAttempt). Never throws, never fails silently. */
export async function logCollectAttempt(db: D1Database, row: CollectAttempt): Promise<void> {
  const { event, outcome, gate, reason, collection_id, ip_hash, ...detail } = row;
  await insertAttempt(
    db,
    'collect_attempts',
    { event, outcome, gate: gate ?? null, reason: reason ?? null, collection_id: collection_id ?? null, ip_hash: ip_hash ?? null },
    detail,
  );
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
