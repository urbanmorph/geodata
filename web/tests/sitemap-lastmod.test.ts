import { describe, it, expect } from 'vitest';
import { lastmodLine } from '../functions/sitemap.xml';

describe('lastmodLine', () => {
  it('emits a <lastmod> from an ISO date or datetime', () => {
    expect(lastmodLine('2024-03-15')).toBe('\n    <lastmod>2024-03-15</lastmod>');
    expect(lastmodLine('2024-03-15T08:30:00Z')).toBe('\n    <lastmod>2024-03-15</lastmod>');
  });

  it('emits nothing when fetched_at is missing or unparseable', () => {
    for (const v of [undefined, null, '', 'today', '2024', '15-03-2024']) {
      expect(lastmodLine(v as string | null | undefined)).toBe('');
    }
  });
});
