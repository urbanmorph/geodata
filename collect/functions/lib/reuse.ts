// Single bridge to the web libs collect reuses unchanged (Phase 1 → promote to
// shared/ at Phase 2). Keeping the deep relative paths in one place means the
// route/handler files import at a stable, shallow depth.

export { nanoid, sha256Hex, ipHashFor } from '../../../web/functions/lib/submit-helpers';
export { verifyTurnstile } from '../../../web/functions/lib/turnstile';
export { persistSubmission } from '../../../web/functions/lib/persist-submission';
