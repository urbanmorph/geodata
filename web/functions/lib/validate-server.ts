// Server-side submission validator. Pure orchestrator over injected gate deps
// (captcha verify, rate-limit check, duplicate lookup) so it can be unit-tested
// without a live D1 / Turnstile.

import { detectCRS, validate as validateFC, type FC } from '../../src/validate';
import { isOpenLicence } from './licenses';

export type SubmissionInput = {
  turnstileToken: string;
  ipHash: string;
  filename: string;
  bytes: number;
  contentHash: string;
  fc: FC;
  rawJson?: unknown;
  name: string;
  description: string | null;
  category: string;
  license: string;
  attribution: string;
  /** When isOriginal=false, sourceUrl must be http/https. When true, free
   *  text 'method' string (optional, ≤500 chars). */
  sourceUrl: string;
  isOriginal: boolean;
};

export type GateResult = {
  ok: boolean;
  warn?: boolean;
  reason?: string;
  info?: Record<string, unknown>;
};

export type ValidationReport = Record<string, GateResult>;

export type ValidationResult =
  | { accept: true; report: ValidationReport }
  | { accept: false; report: ValidationReport; reason: string };

export type ValidationDeps = {
  verifyCaptcha: (token: string) => Promise<boolean>;
  checkRate: (ipHash: string) => Promise<{ ok: boolean; retryAfter?: number }>;
  findDuplicate: (contentHash: string) => Promise<string | null>;
};

const MAX_BYTES = 500 * 1024 * 1024;
const VALID_EXTENSIONS = new Set(['geojson', 'json', 'kml', 'kmz', 'gpx', 'tcx', 'parquet']);
const MIN_NAME = 3;
const MAX_NAME = 120;
const MIN_ATTRIB = 3;
const MAX_ATTRIB = 200;
const MIN_VALID_RATIO = 0.95;

const OK_CRS = new Set([
  'urn:ogc:def:crs:OGC:1.3:CRS84',
  'urn:ogc:def:crs:OGC:1.3:CRS:84',
  'urn:ogc:def:crs:EPSG::4326',
  'EPSG:4326',
]);

function extOf(filename: string): string | null {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : null;
}

function hasControlChars(s: string): boolean {
  return /[\x00-\x1F\x7F]/.test(s);
}

function reject(report: ValidationReport, gate: string, reason: string): ValidationResult {
  report[gate] = { ...(report[gate] ?? { ok: false }), ok: false, reason };
  return { accept: false, report, reason };
}

export async function validateSubmission(
  input: SubmissionInput,
  deps: ValidationDeps,
): Promise<ValidationResult> {
  const report: ValidationReport = {};

  const captchaOk = await deps.verifyCaptcha(input.turnstileToken);
  report.captcha = { ok: captchaOk };
  if (!captchaOk) return reject(report, 'captcha', 'captcha failed');

  const rate = await deps.checkRate(input.ipHash);
  report.rateLimit = {
    ok: rate.ok,
    info: rate.retryAfter ? { retryAfter: rate.retryAfter } : undefined,
  };
  if (!rate.ok) return reject(report, 'rateLimit', 'rate limit exceeded');

  if (input.bytes > MAX_BYTES) {
    report.size = { ok: false, info: { bytes: input.bytes } };
    return reject(report, 'size', 'size too large');
  }
  report.size = { ok: true, info: { bytes: input.bytes } };

  if (
    input.filename.length < 1 ||
    input.filename.length > 255 ||
    hasControlChars(input.filename)
  ) {
    report.filename = { ok: false };
    return reject(report, 'filename', 'filename invalid');
  }
  report.filename = { ok: true };

  const ext = extOf(input.filename);
  if (!ext || !VALID_EXTENSIONS.has(ext)) {
    report.format = { ok: false, info: ext ? { ext } : undefined };
    return reject(report, 'format', 'format unsupported');
  }
  report.format = { ok: true, info: { ext } };

  if (
    input.name.length < MIN_NAME ||
    input.name.length > MAX_NAME ||
    hasControlChars(input.name)
  ) {
    report.name = { ok: false };
    return reject(report, 'name', 'name invalid');
  }
  report.name = { ok: true };

  if (!isOpenLicence(input.license)) {
    report.license = { ok: false };
    return reject(report, 'license', 'licence not on allow-list');
  }
  report.license = { ok: true };

  if (
    input.attribution.length < MIN_ATTRIB ||
    input.attribution.length > MAX_ATTRIB ||
    /^https?:\/\//i.test(input.attribution)
  ) {
    report.attribution = { ok: false };
    return reject(report, 'attribution', 'attribution invalid');
  }
  report.attribution = { ok: true };

  if (input.isOriginal) {
    // Original work: sourceUrl is free-text 'method'. Optional, length-capped.
    if (input.sourceUrl && input.sourceUrl.length > 500) {
      report.sourceUrl = { ok: false };
      return reject(report, 'sourceUrl', 'method description too long (max 500 chars)');
    }
    report.sourceUrl = { ok: true, info: { mode: 'original' } };
  } else {
    let sourceOk = false;
    try {
      const u = new URL(input.sourceUrl);
      sourceOk = u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      sourceOk = false;
    }
    if (!sourceOk) {
      report.sourceUrl = { ok: false };
      return reject(report, 'sourceUrl', 'source URL invalid');
    }
    report.sourceUrl = { ok: true };
  }

  const declared = detectCRS(input.rawJson);
  if (declared && !OK_CRS.has(declared)) {
    report.crs = { ok: false, info: { declared } };
    return reject(report, 'crs', 'CRS not EPSG:4326');
  }
  report.crs = { ok: true, info: declared ? { declared } : undefined };

  const v = validateFC(input.fc, input.rawJson);
  const total = v.count;
  const valid = total - v.invalid;
  const ratio = total > 0 ? valid / total : 0;
  if (total === 0 || ratio < MIN_VALID_RATIO) {
    report.geometry = { ok: false, info: { total, valid, ratio, byType: v.byType } };
    return reject(report, 'geometry', 'geometry validity below 95%');
  }
  report.geometry = { ok: true, info: { total, valid, ratio, byType: v.byType } };

  report.extent = {
    ok: true,
    warn: v.outsideIndia > 0,
    info: { outsideIndia: v.outsideIndia, bbox: v.bbox },
  };

  const matchId = await deps.findDuplicate(input.contentHash);
  report.duplicate = {
    ok: true,
    warn: !!matchId,
    info: matchId ? { matchId } : undefined,
  };

  return { accept: true, report };
}
