// POST /api/submit — accept a geo file + metadata, run server-side
// moderation, write to R2 + D1, return share URL + admin token (shown once).
//
// Format strategy: the browser parses with src/parse-geo.ts and POSTs both
// the raw file (for storage + content hash) and the resulting FeatureCollection
// as `fc_json` for non-trivial formats. For GeoJSON/JSON the file IS the FC
// so the server parses it natively and `fc_json` is ignored.

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

const contentTypeFor = (ext: string): string => {
  if (ext === 'geojson' || ext === 'json') return 'application/geo+json';
  if (ext === 'kml') return 'application/vnd.google-earth.kml+xml';
  if (ext === 'kmz') return 'application/vnd.google-earth.kmz';
  if (ext === 'parquet') return 'application/x-parquet';
  return 'application/octet-stream';
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

  const f = (k: string) => ((form.get(k) as string) || '').trim();
  const turnstileToken = f('turnstile_token');
  const name = f('name');
  const description = f('description') || null;
  const category = f('category');
  const license = f('license');
  const attribution = f('attribution');
  const sourceUrl = f('source_url');

  const filename = sanitizeFilename(file.name);
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const ALLOWED = new Set(['geojson', 'json', 'kml', 'kmz', 'parquet']);
  if (!ALLOWED.has(ext)) {
    return j(415, {
      error: `unsupported file extension .${ext} — accepts: ${[...ALLOWED].join(', ')}`,
    });
  }

  const bytes = await file.arrayBuffer();
  const contentHash = await sha256Hex(bytes);

  let rawJson: unknown;
  let fc: ReturnType<typeof normaliseFC>;
  try {
    if (ext === 'geojson' || ext === 'json') {
      rawJson = JSON.parse(new TextDecoder().decode(bytes));
      fc = normaliseFC(rawJson);
    } else {
      // Browser parsed it; trust the FC the client sent.
      const fcField = form.get('fc_json');
      const fcText =
        fcField instanceof File ? await fcField.text() : typeof fcField === 'string' ? fcField : '';
      if (!fcText) return j(400, { error: 'missing fc_json for non-GeoJSON upload' });
      rawJson = JSON.parse(fcText);
      fc = normaliseFC(rawJson);
    }
  } catch (e) {
    return j(400, { error: 'failed to parse FeatureCollection', detail: (e as Error).message });
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
          contentType: contentTypeFor(ext),
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
