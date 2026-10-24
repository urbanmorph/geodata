// Writes one attempt row (submit_attempts or collect_attempts) with its detail
// columns from migration 0013: the reference shown to the contributor, the
// submission created, the failing step, the exact error, timing and cleanup.
// Shared by /api/submit (submit-log.ts) and collect (collect-log.ts); no other
// dependencies, so collect does not pull in the submit validator.

// Just the slice of D1 used here, so this module needs no ambient Cloudflare
// types (collect's browser-side tests import it through collect-log).
type AttemptDB = { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> } } };

const DETAIL_COLUMNS = ['attempt_id', 'submission_id', 'step', 'detail', 'duration_ms', 'cleanup'] as const;
export type AttemptDetail = Partial<Record<(typeof DETAIL_COLUMNS)[number], string | number | null>>;

/** Write one attempt row to `table` (submit_attempts or collect_attempts): a
 *  JSON line in the Worker logs, then the row with its detail columns. Never
 *  throws. If the detail columns are missing (code deployed before migration
 *  0013) it falls back to the base columns and says so; if the database is
 *  unreachable the whole attempt goes to the error log. */
export async function insertAttempt(
  db: AttemptDB,
  table: 'submit_attempts' | 'collect_attempts',
  base: Record<string, string | number | null>,
  detail: AttemptDetail,
): Promise<void> {
  const event = table === 'submit_attempts' ? 'submit_attempt' : 'collect_attempt';
  console.log(JSON.stringify({ event, ...base, ...detail }));
  const insert = (cols: string[], vals: unknown[]) =>
    db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).bind(...vals).run();
  const baseCols = Object.keys(base);
  const baseVals = Object.values(base);
  try {
    await insert([...baseCols, ...DETAIL_COLUMNS], [...baseVals, ...DETAIL_COLUMNS.map((c) => detail[c] ?? null)]);
    return;
  } catch (e) {
    console.error(`${table} logging degraded (${(e as Error).message}); retrying without detail columns`);
  }
  try {
    await insert(baseCols, baseVals);
  } catch (e) {
    console.error(`${table} logging failed (${(e as Error).message}); attempt: ${JSON.stringify({ ...base, ...detail })}`);
  }
}

