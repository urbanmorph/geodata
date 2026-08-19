import { describe, it, expect } from 'vitest';
import { deriveKey } from '../src/schema/derive-key';

describe('deriveKey', () => {
  it('slugifies a label to a valid key', () => {
    expect(deriveKey('Name of the place')).toBe('name_of_the_place');
    expect(deriveKey('Condition!')).toBe('condition');
    expect(deriveKey('A  B   C')).toBe('a_b_c');
  });

  it('prefixes when it would not start with a letter', () => {
    expect(deriveKey('123 count')).toBe('f_123_count');
  });

  it('falls back to "field" for empty / non-latin labels', () => {
    expect(deriveKey('   ')).toBe('field');
    expect(deriveKey('  !!  ')).toBe('field');
  });

  it('makes the key unique against existing keys', () => {
    expect(deriveKey('Name', ['name'])).toBe('name_2');
    expect(deriveKey('Name', ['name', 'name_2'])).toBe('name_3');
  });

  it('always matches the meta-schema key pattern', () => {
    const re = /^[a-z][a-z0-9_]*$/;
    for (const label of ['Name', '99 bottles', '   ', 'Full Name (legal)', 'X']) {
      expect(re.test(deriveKey(label))).toBe(true);
    }
  });
});
