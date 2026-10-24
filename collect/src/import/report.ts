// What happened to every row of an imported file: added, skipped in the browser
// (no coordinates, didn't fit the form), or refused by the server, each with
// its reason and original cells (for the "rows not added" download). A failed
// or unconfirmed import is reported as such, with its reference.

import { summarizeErrors, type Reason } from './check';
import type { BuildResult, ImportError } from './build';
import type { ParsedFeature } from './parse';
import { escapeHtml } from '../util';
import { ApiError } from '../api';

type RowError = { index: number; error: string };
export type ImportReply =
  | { imported: number; total: number; errors: RowError[]; attempt_id?: string }
  /** errors / notSaved: the server's exact lists (indices into the records sent), when it replied. */
  | { failed: string; imported?: number; attemptId?: string; errors?: RowError[]; notSaved?: number[] };

export interface ImportReport {
  total: number;
  added: number;
  notAdded: ImportError[];
  reasons: Reason[];
  attemptId?: string;
  failed?: string;
  /** No reply at all: the rows may or may not have been saved. */
  unconfirmed?: boolean;
}

/** An import request that threw: a server refusal (with how many rows it added,
 *  and its reference) or no reply at all (the outcome is unknown). */
export function importFailure(e: unknown): ImportReply {
  if (!(e instanceof ApiError)) return { failed: (e as Error)?.message || 'no reply' };
  const imported = typeof e.body.imported === 'number' ? e.body.imported : e.status < 500 ? 0 : undefined;
  const errors = Array.isArray(e.body.errors) ? (e.body.errors as RowError[]) : undefined;
  const notSaved = Array.isArray(e.body.not_saved) ? (e.body.not_saved as number[]) : undefined;
  return { failed: e.message, imported, attemptId: typeof e.body.attempt_id === 'string' ? e.body.attempt_id : undefined, errors, notSaved };
}

const IMPORT_CHUNK = 5000; // the server's per-request limit

/** Send records in requests of at most 5000 and merge the replies, with row
 *  indices across the whole list. A failed request stops the rest: its own
 *  lists are kept and every row of the chunks not sent is reported not saved. */
export async function importInChunks<T>(records: T[], send: (chunk: T[]) => Promise<ImportReply>): Promise<ImportReply> {
  let imported = 0;
  const errors: RowError[] = [];
  let attempt: string | undefined;
  for (let start = 0; start < records.length || start === 0; start += IMPORT_CHUNK) {
    const chunk = records.slice(start, start + IMPORT_CHUNK);
    let reply: ImportReply;
    try { reply = await send(chunk); } catch (e) { reply = importFailure(e); }
    const shift = (rs: RowError[] = []) => rs.map((r) => ({ index: r.index + start, error: r.error }));
    if ('failed' in reply) {
      if (reply.imported === undefined) return { failed: reply.failed, attemptId: reply.attemptId };
      const rest = Array.from({ length: Math.max(0, records.length - start - IMPORT_CHUNK) }, (_, i) => start + IMPORT_CHUNK + i);
      return {
        failed: reply.failed, imported: imported + reply.imported, attemptId: reply.attemptId ?? attempt,
        errors: [...errors, ...shift(reply.errors)],
        // without the server's list, nothing of this chunk is known to be saved
        notSaved: [...(reply.notSaved ? reply.notSaved.map((i) => i + start) : chunk.map((_, i) => start + i).slice(reply.imported)), ...rest],
      };
    }
    imported += reply.imported;
    errors.push(...shift(reply.errors));
    attempt = reply.attempt_id ?? attempt;
    if (chunk.length < IMPORT_CHUNK) break;
  }
  return { imported, total: records.length, errors, attempt_id: attempt };
}

export function importReport(features: ParsedFeature[], built: BuildResult, reply: ImportReply): ImportReport {
  const sourceOf = (i: number) => features[built.rows[i]]?.props ?? {};
  const notAdded: ImportError[] = [...built.errors];
  let added: number;
  let attemptId: string | undefined;
  let failed: string | undefined;
  let unconfirmed = false;
  if ('failed' in reply) {
    failed = reply.failed;
    attemptId = reply.attemptId;
    if (reply.imported === undefined) unconfirmed = true;
    added = reply.imported ?? 0;
    for (const e of reply.errors ?? []) notAdded.push({ row: built.rows[e.index], error: e.error, source: sourceOf(e.index) });
    // The server's list of rows not saved; without one, assume none after the first `added` were.
    const notSaved = reply.notSaved ?? (unconfirmed ? [] : built.records.map((_, i) => i).slice(added));
    for (const i of notSaved) notAdded.push({ row: built.rows[i], error: 'not saved (the import stopped)', source: sourceOf(i) });
  } else {
    added = reply.imported;
    attemptId = reply.attempt_id;
    for (const e of reply.errors) notAdded.push({ row: built.rows[e.index], error: e.error, source: sourceOf(e.index) });
  }
  notAdded.sort((a, b) => a.row - b.row);
  return { total: features.length, added, notAdded, reasons: summarizeErrors(notAdded), attemptId, failed, unconfirmed };
}

const rows = (n: number) => `${n} row${n === 1 ? '' : 's'}`;

export function importReportHtml(r: ImportReport): string {
  const ref = r.attemptId ? ` Reference: <code>${escapeHtml(r.attemptId)}</code>.` : '';
  if (r.unconfirmed) {
    return `<div class="notice"><div><strong>We couldn't confirm the import</strong> (${escapeHtml(r.failed ?? '')}). Open the map and check how many points it has before importing again, so nothing is added twice.</div></div>`;
  }
  const headline = r.added === r.total ? `All ${rows(r.total)} added to the map.` : `${r.added} of ${rows(r.total)} added to the map.`;
  if (!r.notAdded.length && !r.failed) return `<p class="ok">✓ ${headline}${ref}</p>`;
  return `<div class="notice"><div>
      <strong>${headline}</strong>${r.failed ? ` ${escapeHtml(r.failed)}` : ''}${ref}
      ${r.reasons.length ? `<ul class="reasons">${r.reasons.slice(0, 8).map((x) => `<li>${escapeHtml(x.reason)} (${x.count})</li>`).join('')}</ul>` : ''}
    </div>
    ${r.notAdded.length ? `<button type="button" id="dl-not-added">⬇ Download the ${rows(r.notAdded.length)} not added</button>
    <p class="hint">Only those rows, each with a <code>why</code> column. Fix them, delete that column, and import the file from Manage.</p>` : ''}
  </div>`;
}
