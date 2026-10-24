// Store a submission completely or not at all: its file(s) in R2, then the
// submission row, its admin token and any extra rows in ONE D1 batch (ordered,
// one transaction). If anything fails, the files already stored are deleted.
//
// Why: the original /api/submit wrote the file, the submission row and the
// token in parallel. The token row (foreign key to submissions) sometimes
// landed first and failed; the handler returned an error while the submission
// row stayed behind and the in-flight file upload was cut off. A contributor's
// 14 MB upload was lost that way in Oct 2026 and they were turned away.
//
// Used by /api/submit and collect's publish.

import { submissionInsert, tokenInsert, type SubmissionRow, type TokenInput } from './submissions';

export interface StoredFile {
  key: string;
  body: ArrayBuffer | string;
  httpMetadata?: R2HTTPMetadata;
}

type R2Like = {
  put(key: string, body: ArrayBuffer | string, opts?: { httpMetadata?: R2HTTPMetadata }): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
};
type D1Like = Pick<D1Database, 'prepare' | 'batch'>;

export type PersistStep = 'store_file' | 'verify_file' | 'write_rows';
export type PersistOutcome =
  | { ok: true; warning?: string }
  | { ok: false; step: PersistStep; detail: string; cleanup: string | null };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const byteLength = (body: ArrayBuffer | string) =>
  typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength;

export async function persistSubmission(
  deps: { r2: R2Like; db: D1Like },
  input: {
    files: StoredFile[];
    submission: SubmissionRow;
    adminToken: TokenInput;
    /** More rows to write in the same transaction (e.g. collect's publication). */
    extra?: (db: D1Like) => D1PreparedStatement[];
  },
): Promise<PersistOutcome> {
  const { r2, db } = deps;
  const touched: string[] = [];
  const undo = async (): Promise<string | null> => {
    if (!touched.length) return null;
    try {
      await r2.delete(touched);
      return `deleted ${touched.length} file(s)`;
    } catch (e) {
      return `cleanup failed: ${message(e)}; orphan files: ${touched.join(', ')}`;
    }
  };
  const fail = async (step: PersistStep, detail: string): Promise<PersistOutcome> => ({
    ok: false, step, detail, cleanup: await undo(),
  });

  for (const f of input.files) {
    touched.push(f.key); // a failed put may still have written: always clean it up
    let stored: { size: number } | null;
    try {
      stored = await r2.put(f.key, f.body, { httpMetadata: f.httpMetadata });
    } catch (e) {
      return fail('store_file', `${f.key}: ${message(e)}`);
    }
    const expected = byteLength(f.body);
    if (!stored || stored.size !== expected) {
      return fail('verify_file', `${f.key}: stored ${stored?.size ?? 'nothing'} of ${expected} bytes`);
    }
  }

  try {
    await db.batch([
      submissionInsert(db, input.submission),
      tokenInsert(db, input.adminToken),
      ...(input.extra?.(db) ?? []),
    ]);
  } catch (e) {
    // The batch is one transaction, but an error can still arrive after it
    // committed (e.g. the connection drops on the reply). Check before
    // deleting the files, or committed rows would lose their file.
    let committed: boolean;
    try {
      committed = !!(await db.prepare('SELECT 1 AS ok FROM submissions WHERE id = ?').bind(input.submission.id).first());
    } catch (check) {
      return {
        ok: false, step: 'write_rows', detail: message(e),
        cleanup: `kept ${touched.length} file(s): could not check whether the rows were written (${message(check)})`,
      };
    }
    if (committed) return { ok: true, warning: `rows committed although the batch reported: ${message(e)}` };
    return fail('write_rows', message(e));
  }
  return { ok: true };
}
