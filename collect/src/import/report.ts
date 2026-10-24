// What happened to every row of an imported file: added, skipped in the browser
// (no coordinates, didn't fit the form), or refused by the server, each with
// its reason and original cells (for the "rows not added" download). A failed
// or unconfirmed import is reported as such, with its reference.

import { summarizeErrors, type Reason } from './check';
import type { BuildResult, ImportError } from './build';
import type { ParsedFeature } from './parse';
import { escapeHtml } from '../util';
import { ApiError } from '../api';

export type ImportReply =
  | { imported: number; total: number; errors: Array<{ index: number; error: string }>; attempt_id?: string }
  | { failed: string; imported?: number; attemptId?: string };

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
  return { failed: e.message, imported, attemptId: typeof e.body.attempt_id === 'string' ? e.body.attempt_id : undefined };
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
    // Batches are written in order: the valid rows after the first `added` were not saved.
    if (!unconfirmed) for (let i = added; i < built.records.length; i++) notAdded.push({ row: built.rows[i], error: 'not saved (the import stopped)', source: sourceOf(i) });
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
