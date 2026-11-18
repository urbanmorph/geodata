// Single bridge to the web libs collect reuses unchanged (Phase 1 → promote to
// shared/ at Phase 2). Keeping the deep relative paths in one place means the
// route/handler files import at a stable, shallow depth.

import type { Env } from '../types';
import { ipHashFor } from '../../../web/functions/lib/submit-helpers';

export { nanoid, sha256Hex } from '../../../web/functions/lib/submit-helpers';
export { verifyTurnstile } from '../../../web/functions/lib/turnstile';
export { persistSubmission } from '../../../web/functions/lib/persist-submission';

/** The caller's IP, hashed with collect's own salt (distinct from web's, so
 *  collect's rate-limit rows never collide with submit's). */
export const collectIpHash = (req: Request, env: Env): Promise<string> => ipHashFor(req, env.IP_SALT || 'collect-v1');
