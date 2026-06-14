import { describe, it, expect } from 'vitest';
import {
  validateSubmission,
  type SubmissionInput,
  type ValidationDeps,
} from '../functions/lib/validate-server';
import { failingGate, attemptRowFromResult, attemptRowReject } from '../functions/lib/submit-log';
import type { FC } from '../src/validate';

function pointFC(x = 72.8, y = 19.0): FC {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: { name: 'x' } },
    ],
  };
}

function input(overrides: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    turnstileToken: 'ok',
    ipHash: 'A',
    filename: 'mumbai_bike_lanes.geojson',
    bytes: 1024,
    contentHash: 'a'.repeat(64),
    fc: pointFC(),
    rawJson: undefined,
    name: 'Mumbai bike lanes',
    description: null,
    category: 'infrastructure',
    license: 'CC-BY-4.0',
    attribution: 'BBMP Open Data Portal',
    sourceUrl: 'https://example.com/data',
    isOriginal: false,
    ...overrides,
  };
}

function deps(overrides: Partial<ValidationDeps> = {}): ValidationDeps {
  return {
    verifyCaptcha: async () => true,
    checkRate: async () => ({ ok: true }),
    findDuplicate: async () => null,
    ...overrides,
  };
}

describe('failingGate', () => {
  it('finds the single gate that rejected a submission', async () => {
    const r = await validateSubmission(
      input({ rawJson: { crs: { properties: { name: 'urn:ogc:def:crs:EPSG::3857' } } } }),
      deps(),
    );
    expect(r.accept).toBe(false);
    expect(failingGate(r.report)).toBe('crs');
  });

  it('returns null for a clean (all-ok) report', async () => {
    const r = await validateSubmission(input(), deps());
    expect(failingGate(r.report)).toBeNull();
  });
});

describe('attemptRowFromResult', () => {
  it('maps an accept to outcome=accepted with null gate/reason', async () => {
    const r = await validateSubmission(input(), deps());
    const row = attemptRowFromResult(r, { ext: 'geojson', bytes: 1024, ipHash: 'A' });
    expect(row).toMatchObject({
      outcome: 'accepted',
      gate: null,
      reason: null,
      ext: 'geojson',
      bytes: 1024,
      ip_hash: 'A',
    });
  });

  it('maps a reject to outcome=rejected carrying the gate + reason', async () => {
    const r = await validateSubmission(input({ license: 'CC-BY-NC-4.0' }), deps());
    const row = attemptRowFromResult(r, { ext: 'geojson', bytes: 50, ipHash: 'B' });
    expect(row.outcome).toBe('rejected');
    expect(row.gate).toBe('license');
    expect(row.reason).toMatch(/licen[cs]e/i);
  });
});

describe('attemptRowReject (pre-validation early exits)', () => {
  it('builds a rejected row from a synthetic gate (e.g. shapefile upload)', () => {
    const row = attemptRowReject('format', 'unsupported extension .shp', {
      ext: 'shp',
      bytes: 10,
      ipHash: null,
    });
    expect(row).toEqual({
      outcome: 'rejected',
      gate: 'format',
      reason: 'unsupported extension .shp',
      ext: 'shp',
      bytes: 10,
      ip_hash: null,
    });
  });
});
