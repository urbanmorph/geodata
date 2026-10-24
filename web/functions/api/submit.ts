// POST /api/submit — accept a geo file + metadata, run server-side
// moderation, store it completely or not at all (persistSubmission), return
// share URL + admin token (shown once).
//
// Every attempt is logged with a reference (attempt_id) that is returned in
// every response, so a contributor's report can be matched to the exact step
// and error. Nothing escapes as a bare 500.
//
// Format strategy: the browser parses with src/parse-geo.ts and POSTs both
// the raw file (for storage + content hash) and the resulting FeatureCollection
// as `fc_json` for non-trivial formats. For GeoJSON/JSON the file IS the FC
// so the server parses it natively and `fc_json` is ignored.

import type { Env as MiddlewareEnv } from './_middleware';
import { validateSubmission } from '../lib/validate-server';
import { verifyTurnstile } from '../lib/turnstile';
import { checkRateLimit } from '../lib/ratelimit';
import { findDuplicateByHash } from '../lib/submissions';
import { persistSubmission } from '../lib/persist-submission';
import { generateToken, hashToken, tokenPrefix } from '../lib/tokens';
import { nanoid, sha256Hex, sanitizeFilename, ipHashFor } from '../lib/submit-helpers';
import { normaliseFC } from '../../src/validate';
import { attemptRowFromResult, attemptRowReject, logAttempt, type AttemptRow } from '../lib/submit-log';

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
  if (/duplicate/i.test(reason)) return 409;
  return 400;
};

const contentTypeFor = (ext: string): string => {
  if (ext === 'geojson' || ext === 'json') return 'application/geo+json';
  if (ext === 'kml') return 'application/vnd.google-earth.kml+xml';
  if (ext === 'kmz') return 'application/vnd.google-earth.kmz';
  if (ext === 'gpx') return 'application/gpx+xml';
  if (ext === 'tcx') return 'application/vnd.garmin.tcx+xml';
  if (ext === 'parquet') return 'application/x-parquet';
  return 'application/octet-stream';
};

// Shown to the contributor when storage fails: plain, and honest that nothing was kept.
const PERSIST_FAILED =
  "We couldn't save your submission, and nothing was kept. Please try again in a moment. " +
  'If it fails again, send us the reference shown below so we can see what happened.';

export const onRequestPost: PagesFunction<Env> = async (ctx) => {
  const attemptId = `att_${nanoid(10)}`;
  const started = Date.now();
  const log = (row: AttemptRow) =>
    ctx.waitUntil(logAttempt(ctx.env.DB, { ...row, attempt_id: attemptId, duration_ms: Date.now() - started }));
  const reply = (status: number, body: Record<string, unknown>) => j(status, { ...body, attempt_id: attemptId });
  try {
    return await handleSubmit(ctx, log, reply);
  } catch (e) {
    const err = e as Error;
    log({ ...attemptRowReject('internal', 'unexpected server error', {}), step: 'internal', detail: err.stack || err.message });
    return reply(500, { error: 'Something went wrong on our side and your submission was not saved. Please try again.' });
  }
};

async function handleSubmit(
  ctx: Parameters<PagesFunction<Env>>[0],
  log: (row: AttemptRow) => void,
  reply: (status: number, body: Record<string, unknown>) => Response,
): Promise<Response> {
  const ipHash = await ipHashFor(ctx.request, ctx.env.IP_SALT || 'geodata-v1');
  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch (e) {
    log({ ...attemptRowReject('body', 'invalid multipart body', { ipHash }), detail: (e as Error).message });
    return reply(400, { error: 'invalid multipart body' });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    log(attemptRowReject('file', 'missing file', { ipHash }));
    return reply(400, { error: 'missing file' });
  }

  const f = (k: string) => ((form.get(k) as string) || '').trim();
  const turnstileToken = f('turnstile_token');
  const name = f('name');
  const description = f('description') || null;
  const category = f('category');
  const license = f('license');
  const attribution = f('attribution');
  const sourceUrl = f('source_url');
  const dataYear = f('data_year') ? parseInt(f('data_year')!, 10) : null;
  const isOriginal = f('is_original') === '1';

  const filename = sanitizeFilename(file.name);
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const ALLOWED = new Set(['geojson', 'json', 'kml', 'kmz', 'gpx', 'tcx', 'parquet']);

  const logMeta = { ext, bytes: file.size, ipHash };

  if (!ALLOWED.has(ext)) {
    log(attemptRowReject('format', `unsupported extension .${ext}`, logMeta));
    return reply(415, {
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
      if (!fcText) {
        log(attemptRowReject('parse', 'missing fc_json for non-GeoJSON upload', logMeta));
        return reply(400, { error: 'missing fc_json for non-GeoJSON upload' });
      }
      rawJson = JSON.parse(fcText);
      fc = normaliseFC(rawJson);
    }
  } catch (e) {
    log({ ...attemptRowReject('parse', 'failed to parse FeatureCollection', logMeta), detail: (e as Error).message });
    return reply(400, { error: 'failed to parse FeatureCollection', detail: (e as Error).message });
  }

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
      isOriginal,
    },
    {
      verifyCaptcha: (t) => verifyTurnstile(t, ctx.env.TURNSTILE_SECRET || ''),
      checkRate: (ip) => checkRateLimit(ctx.env.DB, ip),
      findDuplicate: (h) => findDuplicateByHash(ctx.env.DB, h),
    },
  );

  if (!result.accept) {
    log(attemptRowFromResult(result, logMeta));
    return reply(codeForReason(result.reason), { error: result.reason, report: result.report });
  }

  const id = nanoid(10);
  const adminToken = generateToken('admin');
  const r2Key = `community/${id}/${filename}`;
  const byType = (result.report.geometry?.info?.byType as Record<string, number>) || {};
  const geometryTypes = Object.keys(byType).join(',');

  const outcome = await persistSubmission(
    { r2: ctx.env.R2, db: ctx.env.DB },
    {
      files: [{
        key: r2Key,
        body: bytes,
        httpMetadata: { contentType: contentTypeFor(ext), contentDisposition: `attachment; filename="${filename}"` },
      }],
      submission: {
        id,
        // Awaits a human curator's review before it goes live in the catalog.
        // Nothing is auto-approved: a curator accepts it via scripts/moderate_submission.py.
        status: 'pending',
        name,
        description,
        category,
        license,
        attribution,
        source_url: sourceUrl,
        data_year: dataYear,
        is_original: isOriginal ? 1 : 0,
        format: ext,
        bytes: file.size,
        feature_count: fc.features.length,
        geometry_types: geometryTypes || null,
        content_hash: contentHash,
        ip_hash: ipHash,
        validation_report: JSON.stringify(result.report),
        r2_key: r2Key,
      },
      adminToken: {
        submissionId: id,
        tokenPrefix: tokenPrefix(adminToken),
        tokenHash: await hashToken(adminToken),
        permission: 'admin',
      },
    },
  );
  if (!outcome.ok) {
    log({
      ...attemptRowReject('persist', 'could not save the submission', logMeta),
      step: outcome.step, detail: outcome.detail, cleanup: outcome.cleanup,
    });
    return reply(500, { error: PERSIST_FAILED });
  }

  log({ ...attemptRowFromResult(result, logMeta), submission_id: id });

  const origin = new URL(ctx.request.url).origin;
  return reply(200, {
    id,
    status: 'pending',
    message: 'Submitted for review. A curator approves it before it appears in the catalog; the link works once it is live.',
    share_url: `${origin}/c/${id}`,
    admin_url: `${origin}/c/${id}?key=${adminToken}`,
    admin_token: adminToken,
    expires_at: null,
    report: result.report,
  });
}

export const onRequest: PagesFunction<Env> = async () =>
  new Response('method not allowed', { status: 405 });
