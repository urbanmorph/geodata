import { describe, it, expect } from 'vitest';
import { OPEN_LICENCES, isOpenLicence, requiresAttribution } from '../functions/lib/licenses';

describe('OPEN_LICENCES', () => {
  it('includes the six expected open licences', () => {
    const ids = OPEN_LICENCES.map((l) => l.id);
    expect(ids).toEqual([
      'CC0-1.0',
      'CC-BY-4.0',
      'CC-BY-SA-4.0',
      'ODbL-1.0',
      'ODC-PDDL-1.0',
      'GODL-India',
    ]);
  });

  it('marks public-domain dedications as not requiring attribution', () => {
    const cc0 = OPEN_LICENCES.find((l) => l.id === 'CC0-1.0');
    const pddl = OPEN_LICENCES.find((l) => l.id === 'ODC-PDDL-1.0');
    expect(cc0?.requiresAttribution).toBe(false);
    expect(pddl?.requiresAttribution).toBe(false);
  });

  it('marks BY/SA licences as requiring attribution', () => {
    const by = OPEN_LICENCES.find((l) => l.id === 'CC-BY-4.0');
    const bySa = OPEN_LICENCES.find((l) => l.id === 'CC-BY-SA-4.0');
    const odbl = OPEN_LICENCES.find((l) => l.id === 'ODbL-1.0');
    expect(by?.requiresAttribution).toBe(true);
    expect(bySa?.requiresAttribution).toBe(true);
    expect(odbl?.requiresAttribution).toBe(true);
  });
});

describe('isOpenLicence', () => {
  it('accepts every id in the allow-list', () => {
    for (const l of OPEN_LICENCES) expect(isOpenLicence(l.id)).toBe(true);
  });

  it('rejects unknown / closed licences', () => {
    expect(isOpenLicence('All Rights Reserved')).toBe(false);
    expect(isOpenLicence('MIT')).toBe(false); // valid OSS code licence, NOT a data licence
    expect(isOpenLicence('CC-BY-NC-4.0')).toBe(false); // non-commercial — not on our list
    expect(isOpenLicence('')).toBe(false);
    expect(isOpenLicence(null as unknown as string)).toBe(false);
    expect(isOpenLicence(undefined as unknown as string)).toBe(false);
  });

  it('is case-sensitive (no fuzzy match)', () => {
    expect(isOpenLicence('cc0-1.0')).toBe(false);
    expect(isOpenLicence('cc-by-4.0')).toBe(false);
  });
});

describe('requiresAttribution', () => {
  it('returns true for BY-style licences', () => {
    expect(requiresAttribution('CC-BY-4.0')).toBe(true);
    expect(requiresAttribution('CC-BY-SA-4.0')).toBe(true);
    expect(requiresAttribution('ODbL-1.0')).toBe(true);
    expect(requiresAttribution('GODL-India')).toBe(true);
  });

  it('returns false for public domain dedications', () => {
    expect(requiresAttribution('CC0-1.0')).toBe(false);
    expect(requiresAttribution('ODC-PDDL-1.0')).toBe(false);
  });

  it('returns false for unknown licences (defensive)', () => {
    expect(requiresAttribution('All Rights Reserved')).toBe(false);
    expect(requiresAttribution('')).toBe(false);
  });
});
