import { describe, it, expect } from 'vitest';
import { generateRecordToken } from '../../functions/lib/tokens';

describe('generateRecordToken', () => {
  it('is rec_ plus 32 URL-safe characters, different every time', () => {
    const a = generateRecordToken();
    expect(a).toMatch(/^rec_[A-Za-z0-9_-]{32}$/);
    expect(generateRecordToken()).not.toBe(a);
  });
});
