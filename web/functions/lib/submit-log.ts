// Funnel instrumentation for /api/submit.
//
// Hard-rejected submissions are bounced at validation BEFORE any DB write, so
// they leave no trace in the `submissions` table — which is why the
// contribution funnel was a black box past `/submit`. This records the outcome
// of every POST (which gate rejected, or accepted) to `submit_attempts` so the
// drop-off becomes measurable.
//
// Privacy: stores only the failing gate + coarse file facts (extension, size)
// and the already-hashed IP. No file bytes, no name / attribution / source text.
// Best-effort: logging must NEVER fail a real submission.

import type { ValidationResult, ValidationReport } from './validate-server';

export type AttemptOutcome = 'accepted' | 'rejected';

export type AttemptRow = {
  outcome: AttemptOutcome;
  gate: string | null; // failing gate key, or null when accepted
  reason: string | null; // human reason string, or null when accepted
  ext: string | null; // file extension
  bytes: number | null; // file size
  ip_hash: string | null; // already-hashed IP (matches submissions/rate_limits)
};

type AttemptMeta = { ext?: string | null; bytes?: number | null; ipHash?: string | null };

/** Coarse file facts shared by every row, with undefined normalised to null. */
function fileFacts(meta: AttemptMeta): Pick<AttemptRow, 'ext' | 'bytes' | 'ip_hash'> {
  return { ext: meta.ext ?? null, bytes: meta.bytes ?? null, ip_hash: meta.ipHash ?? null };
}

/** First gate in the validation report with ok === false (validateSubmission
 *  short-circuits on the first failure, so there is at most one). */
export function failingGate(report: ValidationReport): string | null {
  for (const [gate, result] of Object.entries(report)) {
    if (result && result.ok === false) return gate;
  }
  return null;
}

/** Build an attempt row from a full validateSubmission result. */
export function attemptRowFromResult(result: ValidationResult, meta: AttemptMeta): AttemptRow {
  return result.accept
    ? { outcome: 'accepted', gate: null, reason: null, ...fileFacts(meta) }
    : { outcome: 'rejected', gate: failingGate(result.report), reason: result.reason, ...fileFacts(meta) };
}

/** Build a rejected row for an early exit that never reaches validateSubmission
 *  (bad format, unparseable file). */
export function attemptRowReject(gate: string, reason: string, meta: AttemptMeta): AttemptRow {
  return { outcome: 'rejected', gate, reason, ...fileFacts(meta) };
}

/** Best-effort insert. Swallows every error so a logging failure (e.g. the
 *  table not yet migrated) can never break a submission. Pair with
 *  ctx.waitUntil() so it adds zero latency to the response. */
export async function logAttempt(db: D1Database, row: AttemptRow): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO submit_attempts (outcome, gate, reason, ext, bytes, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(row.outcome, row.gate, row.reason, row.ext, row.bytes, row.ip_hash)
      .run();
  } catch {
    /* logging is best-effort — never propagate */
  }
}
