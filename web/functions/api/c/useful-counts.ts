// GET /api/c/useful-counts — bulk up-vote tally for every community
// submission. Client patches the prerendered 👍 counts on the home grid
// in-place so they're always current (no catalog.json drift), mirroring
// the /api/dl/counts pattern.
//
// Response shape: { "<submission_id>": <up_count>, ... }
// Submissions with zero up votes are omitted — the client treats missing
// entries as 0 (the baked default).

import type { Env } from '../../_middleware';
import { countAllUpVotes } from '../../lib/ratings';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  try {
    const tally = await countAllUpVotes(ctx.env.DB);
    const body = Object.fromEntries(tally);
    return new Response(JSON.stringify(body), {
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=30, stale-while-revalidate=120',
      },
    });
  } catch {
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    });
  }
};
