import { describe, it, expect } from 'vitest';
import { statusOf, filterByStatus, countsOf } from '../src/review';

const F = (status?: string) => ({ properties: status ? { _status: status } : {} });

describe('statusOf', () => {
  it('reads _status, defaulting to published', () => {
    expect(statusOf(F('pending'))).toBe('pending');
    expect(statusOf(F())).toBe('published'); // no _status → published
  });
});

describe('filterByStatus', () => {
  const feats = [F('pending'), F('published'), F('rejected'), F('pending'), F()];
  it('empty status returns all (the "All" chip)', () => {
    expect(filterByStatus(feats, '')).toHaveLength(5);
  });
  it('filters to a single status', () => {
    expect(filterByStatus(feats, 'pending')).toHaveLength(2);
    expect(filterByStatus(feats, 'published')).toHaveLength(2); // 1 explicit + 1 default
    expect(filterByStatus(feats, 'rejected')).toHaveLength(1);
  });
  it('returns the same array reference for the All case (no copy)', () => {
    expect(filterByStatus(feats, '')).toBe(feats);
  });
});

describe('countsOf', () => {
  it('tallies each status plus total', () => {
    const feats = [F('pending'), F('published'), F('rejected'), F('pending'), F()];
    expect(countsOf(feats)).toEqual({ published: 2, pending: 2, rejected: 1, total: 5 });
  });
  it('empty set is all zeros', () => {
    expect(countsOf([])).toEqual({ published: 0, pending: 0, rejected: 0, total: 0 });
  });
});
