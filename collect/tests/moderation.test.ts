import { describe, it, expect } from 'vitest';
import { recordStatusFor } from '../functions/lib/moderation';

describe('recordStatusFor — who needs approval', () => {
  it('the owner (admin) publishes their own additions immediately, even when moderated', () => {
    // Owner imports/captures are trusted; moderation is for reviewing others, not yourself.
    expect(recordStatusFor(true, 1)).toBe('published');
    expect(recordStatusFor(true, 0)).toBe('published');
  });
  it('a contributor (edit link) goes pending on a moderated map', () => {
    expect(recordStatusFor(false, 1)).toBe('pending');
  });
  it('a contributor publishes immediately on an unmoderated map', () => {
    expect(recordStatusFor(false, 0)).toBe('published');
  });
  it('treats moderation as truthy/falsy (D1 stores 0/1)', () => {
    expect(recordStatusFor(false, 1)).toBe('pending');
    expect(recordStatusFor(false, 0)).toBe('published');
  });
});
