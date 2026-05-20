// POST /api/submit — accept a GeoJSON file + metadata, run server-side
// moderation, write to R2 + D1, return share URL + admin token (shown once).
//
// v3.1.0 scope: GeoJSON / JSON only. KML/KMZ/Parquet submission deferred
// (server bundle would need togeojson / jszip / duckdb — too heavy for now).
// /verify still supports all four; /submit narrows the on-ramp.

import type { Env as MiddlewareEnv } from './_middleware';
import { validateSubmission } from '../lib/validate-server';
import { verifyTurnstile } from '../lib/turnstile';
import { checkRateLimit } from '../lib/ratelimit';
import { insertSubmission, insertToken, findDuplicateByHash } from '../lib/submissions';
import { generateToken, hashToken, tokenPrefix } from '../lib/tokens';
import { nanoid, sha256Hex, sanitizeFilename, ipHashFor } from '../lib/submit-helpers';
import { normaliseFC } from '../../src/validate';

type Env = MiddlewareEnv & {
  TURNSTILE_SECRET: string;
  IP_SALT?: string;
};

const j = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const codeForReason = (reason: string): number => {
  if (/rate/i.test(reason)) return 429;
  if (/size/i.test(reason)) return 413;
  if (/format/i.test(reason)) return 415;
  return 400;
};

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    return j(400, { error: 'invalid multipart body' });
  }

  const file = form.get('file');
  if (!(file instanceof File)) return j(400, { error: 'missing file' });

  const turnstileToken = (form.get('turnstile_token') as string) || '';
  const name = ((form.get('name') as string) || '').trim();
  const description = ((form.get('description') as string) || '').trim() || null;
  const category = ((form.get('category') as string) || '').trim();
  const license = ((form.get('license') as string) || '').trim();
  const attribution = ((form.get('attribution') as string) || '').trim();
  const sourceUrl = ((form.get('source_url') as string) || '').trim();

  const filename = sanitizeFilename(file.name);
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext !== 'geojson' && ext !== 'json') {
    return j(415, {
      error: 'submit accepts GeoJSON / JSON only right now — KML, KMZ and Parquet are coming. Use /verify to preview those formats locally.',
    });
  }

  const bytes = await file.arrayBuffer();
  const contentHash = await sha256Hex(bytes);

  let rawJson: unknown;
  let fc: ReturnType<typeof normaliseFC>;
  try {
    rawJson = JSON.parse(new TextDecoder().decode(bytes));
    fc = normaliseFC(rawJson);
  } catch (e) {
    return j(400, { error: 'file is not valid GeoJSON', detail: (e as Error).message });
  }

  const ipHash = await ipHashFor(ctx.request, ctx.env.IP_SALT || 'geodata-v1');

  const result = await validateSubmission(
    {
      turnstileToken,
      ipHash,
      filename,
      bytes: file.size,
      contentHash,
      fc,
      rawJson,
      name,
      description,
      category,
      license,
      attribution,
      sourceUrl,
    },
    {
      verifyCaptcha: (t) => verifyTurnstile(t, ctx.env.TURNSTILE_SECRET || ''),
      checkRate: (ip) => checkRateLimit(ctx.env.DB, ip),
      findDuplicate: (h) => findDuplicateByHash(ctx.env.DB, h),
    },
  );

  if (!result.accept) {
    return j(codeForReason(result.reason), { error: result.reason, report: result.report });
  }

  const id = nanoid(10);
  const adminToken = generateToken('admin');
  const r2Key = `community/${id}/${filename}`;
  const byType = (result.report.geometry?.info?.byType as Record<string, number>) || {};
  const geometryTypes = Object.keys(byType).join(',');

  try {
    await Promise.all([
      ctx.env.R2.put(r2Key, bytes, {
        httpMetadata: {
          contentType: 'application/geo+json',
          contentDisposition: `attachment; filename="${filename}"`,
        },
      }),
      insertSubmission(ctx.env.DB, {
        id,
        status: 'accepted',
        name,
        description,
        category,
        license,
        attribution,
        source_url: sourceUrl,
        format: ext,
        bytes: file.size,
        feature_count: fc.features.length,
        geometry_types: geometryTypes || null,
        content_hash: contentHash,
        ip_hash: ipHash,
        validation_report: JSON.stringify(result.report),
        r2_key: r2Key,
      }),
      insertToken(ctx.env.DB, {
        submissionId: id,
        tokenPrefix: tokenPrefix(adminToken),
        tokenHash: await hashToken(adminToken),
        permission: 'admin',
      }),
    ]);
  } catch (e) {
    return j(500, { error: 'failed to persist submission', detail: (e as Error).message });
  }

  const origin = new URL(ctx.request.url).origin;
  return j(200, {
    id,
    share_url: `${origin}/c/${id}`,
    admin_url: `${origin}/c/${id}?key=${adminToken}`,
    admin_token: adminToken,
    expires_at: null,
    report: result.report,
  });
};

export const onRequest: PagesFunction<Env> = async () =>
  new Response('method not allowed', { status: 405 });
