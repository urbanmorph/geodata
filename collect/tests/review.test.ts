import { describe, it, expect } from 'vitest';
import { statusOf, filterByStatus, countsOf, popupActions, recordWho, recordVia, recordPlace } from '../src/review';

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

describe('recordWho — the "who" prefix on a record', () => {
  it('imported data credits its source', () => {
    expect(recordWho('SOI Atlas 2021', null)).toBe('⇪ from SOI Atlas 2021');
  });
  it('a contributor who typed a name is shown', () => {
    expect(recordWho(null, 'Jane')).toBe('by Jane');
  });
  it('an unnamed capture shows nothing — no "by anonymous" (there are no accounts)', () => {
    expect(recordWho(null, null)).toBe('');
    expect(recordWho(null, '')).toBe('');
    expect(recordWho('', '   ')).toBe('');
    expect(recordWho(undefined, undefined)).toBe('');
  });
  it('an import source wins over a contributor name', () => {
    expect(recordWho('Bhuvan', 'Jane')).toBe('⇪ from Bhuvan');
  });
});

describe('popupActions', () => {
  const acts = (s: string) => popupActions(s).map((a) => a.act);
  it('pending can be rejected or approved, and opened', () => {
    expect(acts('pending')).toEqual(['rejected', 'published', 'open']);
  });
  it('rejected can be re-approved (never re-rejected), and opened', () => {
    expect(acts('rejected')).toEqual(['published', 'open']);
  });
  it('approved has nothing to moderate — only open', () => {
    expect(acts('published')).toEqual(['open']);
  });
  it('an unknown/default status offers no moderation, only open', () => {
    expect(acts('')).toEqual(['open']);
  });
  it('every action carries a label and a css class for the tooltip button', () => {
    for (const a of popupActions('pending')) {
      expect(a.label).toBeTruthy();
      expect(a.cls).toBeTruthy();
    }
  });
});

describe('recordVia — which named link added a record (admin only)', () => {
  it('names the labelled link', () => {
    expect(recordVia('Ward 12 team')).toBe('via Ward 12 team');
  });
  it('shows nothing for an unlabelled or unknown link', () => {
    expect(recordVia(null)).toBe('');
    expect(recordVia(undefined)).toBe('');
    expect(recordVia('  ')).toBe('');
  });
});

describe('recordWhen', () => {
  it("shows when a point was added: the phone's capture time, else when it was saved", async () => {
    const { recordWhen } = await import('../src/review');
    expect(recordWhen('2026-10-24T05:10:00.000Z', '2026-10-24T09:00:00.000Z', 'Asia/Kolkata')).toBe('added 24 Oct 2026, 10:40 am');
    expect(recordWhen(null, '2026-10-24T09:00:00.000Z', 'Asia/Kolkata')).toBe('added 24 Oct 2026, 2:30 pm');
    expect(recordWhen(null, undefined)).toBe('');
  });
});

describe('recordPlace', () => {
  it('names district then state, as plain text for the caller to escape', () => {
    expect(recordPlace({ district: 'Bengaluru Urban', state: 'KARNATAKA' })).toBe('📍 Bengaluru Urban, KARNATAKA');
    expect(recordPlace({ state: '<img src=x onerror=alert(1)>' })).toBe('📍 <img src=x onerror=alert(1)>');
  });
  it('is empty with no place', () => {
    expect(recordPlace(null)).toBe('');
    expect(recordPlace({})).toBe('');
  });
});

import { withStatus, withoutRecord, withAiReview } from '../src/review';

// After one approve, reject, delete or notes review, the admin's cached list is
// changed in place instead of fetching every record of the map again.
describe('changing the cached review list in place', () => {
  const feats = [
    { id: 'a', properties: { _status: 'pending', name: 'A', _ai: { status: 'done', description: 'tree', review: undefined } } },
    { id: 'b', properties: { _status: 'pending', name: 'B' } },
  ];
  it('sets one record\'s status, leaving the list it came from as it was', () => {
    const out = withStatus(feats, 'b', 'published');
    expect(out.map(statusOf)).toEqual(['pending', 'published']);
    expect(feats.map(statusOf)).toEqual(['pending', 'pending']);
    expect(countsOf(out)).toMatchObject({ pending: 1, published: 1 });
  });
  it('drops a deleted record', () => {
    expect(withoutRecord(feats, 'a').map((f) => f.id)).toEqual(['b']);
  });
  it('applies a notes review: the reply\'s answers and status, and the notes marked', () => {
    const out = withAiReview(feats, 'a', { review: 'accepted', status: 'published', properties: { name: 'A', kind: 'Neem' } }, 'a neem tree');
    expect(out[0].properties).toMatchObject({ _status: 'published', name: 'A', kind: 'Neem', _ai: { status: 'done', review: 'accepted', description: 'a neem tree' } });
    const discarded = withAiReview(feats, 'a', { review: 'discarded' });
    expect(discarded[0].properties).toMatchObject({ _status: 'pending', _ai: { review: 'discarded', description: 'tree' } });
  });
});

import { REVIEW_PAGE, rowsToShow, reviewSignature } from '../src/review';

// A map can hold 100,000 points: the list shows a page at a time ("Show more"),
// and the background refresh compares a short signature, not a joined string.
describe('the review list, a page at a time', () => {
  it('shows one page to start, never more than there are', () => {
    expect(rowsToShow(0, 100_000)).toBe(REVIEW_PAGE);
    expect(rowsToShow(0, 12)).toBe(12);
  });
  it('keeps what was shown, and grows to include a row it must show (Back from a point)', () => {
    expect(rowsToShow(400, 100_000)).toBe(400);
    expect(rowsToShow(REVIEW_PAGE, 100_000, 950)).toBe(1000);
    expect(rowsToShow(REVIEW_PAGE, 960, 950)).toBe(960);
  });
});

describe('reviewSignature', () => {
  const R = (id: string, status?: string) => ({ id, ...F(status) });
  it('is the same for the same points and statuses', () => {
    expect(reviewSignature([R('a'), R('b', 'pending')])).toBe(reviewSignature([R('a'), R('b', 'pending')]));
  });
  it('changes when a point is added, removed, or its status changes', () => {
    const base = reviewSignature([R('a'), R('b', 'pending')]);
    expect(reviewSignature([R('a'), R('b', 'published')])).not.toBe(base);
    expect(reviewSignature([R('a')])).not.toBe(base);
    expect(reviewSignature([R('a'), R('c', 'pending')])).not.toBe(base);
  });
  it('stays short for a big map', () => {
    const many = Array.from({ length: 100_000 }, (_, i) => R(`rec${i}`));
    expect(reviewSignature(many).length).toBeLessThan(32);
  });
});
