// The "Submit to bharatlas?" sheet: its counts agree with their verbs
// ("Your 1 approved point are already saved" read wrong).
import { describe, it, expect } from 'vitest';
import { savedLine, pendingLine } from '../src/publish/confirm';

describe('publish confirmation copy', () => {
  it('one approved point is saved; several are', () => {
    expect(savedLine(1)).toBe('Your 1 approved point is already saved and shown on this map.');
    expect(savedLine(3)).toBe('Your 3 approved points are already saved and shown on this map.');
  });

  it('counts pending points the same way', () => {
    expect(pendingLine(1)).toBe("1 pending point won't be included until you approve it in Review.");
    expect(pendingLine(2)).toBe("2 pending points won't be included until you approve them in Review.");
  });
});
