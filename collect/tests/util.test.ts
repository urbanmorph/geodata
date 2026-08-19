import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../src/util';

describe('escapeHtml', () => {
  it('neutralises markup-injection characters', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml('a & b "q" \'x\'')).toBe('a &amp; b &quot;q&quot; &#39;x&#39;');
  });
  it('coerces nullish + non-strings to a safe string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(42)).toBe('42');
  });
  it('leaves plain text untouched', () => {
    expect(escapeHtml('Kaveri footpath')).toBe('Kaveri footpath');
  });
});
