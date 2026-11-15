// One licence table for every surface (prerender JSON-LD, /view and /c pages,
// the About panel, the submit allow-list). Exact ids, never substrings: a
// substring match sent "CC-BY-NC-4.0" to plain CC BY.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { licenceUrl, isNonCommercial, LICENCE_URLS } from '../../shared/licences.mjs';
import { OPEN_LICENCES } from '../functions/lib/licenses';

describe('licenceUrl', () => {
  it('maps exact ids', () => {
    expect(licenceUrl('CC0-1.0')).toBe('https://creativecommons.org/publicdomain/zero/1.0/');
    expect(licenceUrl('GODL-India')).toBe('https://data.gov.in/government-open-data-license-india');
    expect(licenceUrl('MIT')).toBe('https://opensource.org/licenses/MIT');
    expect(licenceUrl('CC-BY-SA-2.5-IN')).toBe('https://creativecommons.org/licenses/by-sa/2.5/in/');
  });

  it('never maps a non-commercial licence to its commercial sibling', () => {
    expect(licenceUrl('CC-BY-NC-4.0')).toBe('https://creativecommons.org/licenses/by-nc/4.0/');
    expect(licenceUrl('CC-BY-NC-SA-4.0')).toBe('https://creativecommons.org/licenses/by-nc-sa/4.0/');
  });

  it('uses the first of a dual licence ("CC0-1.0 / CC-BY-4.0")', () => {
    expect(licenceUrl('CC0-1.0 / CC-BY-4.0')).toBe(LICENCE_URLS['CC0-1.0']);
  });

  it('is undefined for unknown or empty ids', () => {
    expect(licenceUrl('Proprietary')).toBeUndefined();
    expect(licenceUrl('')).toBeUndefined();
    expect(licenceUrl(undefined)).toBeUndefined();
  });

  it('knows every licence the catalog uses', () => {
    const cat = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8')) as { layers: { licence?: string }[] };
    for (const l of cat.layers) if (l.licence) expect(licenceUrl(l.licence), l.licence).toBeDefined();
  });

  it('agrees with the submit allow-list', () => {
    for (const l of OPEN_LICENCES) expect(licenceUrl(l.id), l.id).toBe(l.url);
  });
});

describe('isNonCommercial', () => {
  it('flags NC licences only', () => {
    expect(isNonCommercial('CC-BY-NC-4.0')).toBe(true);
    expect(isNonCommercial('CC-BY-NC-SA-4.0')).toBe(true);
    expect(isNonCommercial('CC-BY-4.0')).toBe(false);
    expect(isNonCommercial('GODL-India')).toBe(false);
    expect(isNonCommercial(undefined)).toBe(false);
  });
});
