// Single bridge to the web libs collect reuses unchanged (Phase 1 → promote to
// shared/ at Phase 2). Keeping the deep relative paths in one place means the
// route/handler files import at a stable, shallow depth.

export { nanoid, sha256Hex, ipHashFor } from '../../../web/functions/lib/submit-helpers';
export { verifyTurnstile } from '../../../web/functions/lib/turnstile';
export { insertSubmission, insertToken } from '../../../web/functions/lib/submissions';
export type { SubmissionRow } from '../../../web/functions/lib/submissions';
