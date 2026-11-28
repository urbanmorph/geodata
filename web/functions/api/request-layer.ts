// POST /api/request-layer: someone asks for a layer bharatlas does not have (docs#request). The request is
// saved with a reference, or refused with nothing kept. Nothing is paid here: the owner checks it can be done
// (an open source that allows any use; a requested layer is never non-commercial), then emails to arrange
// Rs 499 by UPI. The email is stored for that reply only and never sent back or shown.
import type { Env } from './_middleware';
import { verifyTurnstile } from '../lib/turnstile';
import { checkRateLimit } from '../lib/ratelimit';
import { json } from '../lib/http';
import { ipHashFor, nanoid, submitterSalt } from '../lib/submit-helpers';

const LIMITS = { what: 2000, place: 200, source: 500, name: 80, email: 200, q: 200 } as const;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type LayerRequest = {
  what: string; place: string; source: string; credit_name: string; email: string; query: string;
};

type Field = keyof typeof LIMITS;
const text = (body: Record<string, unknown>, f: Field) => (typeof body[f] === 'string' ? (body[f] as string).trim() : '');

/** The request's fields, trimmed and checked, or the first field that is wrong. */
export function validateRequest(body: Record<string, unknown>):
  { ok: true; value: LayerRequest } | { ok: false; field: Field; error: string } {
  for (const f of Object.keys(LIMITS) as Field[]) {
    if (text(body, f).length > LIMITS[f]) return { ok: false, field: f, error: `${f} is longer than ${LIMITS[f]} characters` };
  }
  if (!text(body, 'what')) return { ok: false, field: 'what', error: 'say what layer you need' };
  if (!EMAIL.test(text(body, 'email'))) return { ok: false, field: 'email', error: 'an email address is needed for our reply' };
  return { ok: true, value: {
    what: text(body, 'what'), place: text(body, 'place'), source: text(body, 'source'),
    credit_name: text(body, 'name'), email: text(body, 'email'), query: text(body, 'q'),
  } };
}

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let body: Record<string, unknown>;
  try {
    body = (await ctx.request.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'send the request as JSON' });
  }
  if (!(await verifyTurnstile(body.turnstile_token as string, ctx.env.TURNSTILE_SECRET || ''))) {
    return json(403, { error: 'the verification check failed; reload the page and try again' });
  }
  const v = validateRequest(body);
  if (!v.ok) return json(400, { error: v.error, field: v.field });
  const ipHash = await ipHashFor(ctx.request, submitterSalt(ctx.env));
  const rate = await checkRateLimit(ctx.env.DB, ipHash);
  if (!rate.ok) return json(429, { error: 'too many requests from here; try again later' }, { 'retry-after': String(rate.retryAfter) });
  const reference = `req_${nanoid(10)}`;
  const r = v.value;
  try {
    await ctx.env.DB.prepare(
      `INSERT INTO layer_requests (id, created_at, what, place, source, credit_name, email, query, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(reference, new Date().toISOString(), r.what, r.place, r.source, r.credit_name, r.email, r.query, ipHash).run();
  } catch (e) {
    console.error('request-layer insert failed', (e as Error).message);
    return json(500, { error: "we couldn't save your request, and nothing was kept; please try again" });
  }
  return json(201, { reference, message: "Request received. We'll reply within 7 days to say whether we can build it. Nothing to pay yet." });
};
