import { describe, it, expect } from 'vitest';
// Pure search-haystack helpers, shared by the build-time prerender and tested
// here. Extracted from prerender.mjs so the alias map has a red-green contract.
import { expandAliases, SEARCH_ALIASES, buildBodyHaystack } from '../src/search-aliases.mjs';

describe('expandAliases — existing behaviour preserved', () => {
  it('leaves text with no alias key unchanged', () => {
    expect(expandAliases('Helipads')).toBe('Helipads');
  });
  it('expands a known key (PMGSY) to its synonyms', () => {
    const out = expandAliases('PMGSY roads').toLowerCase();
    expect(out).toContain('pradhan mantri gram sadak yojana');
  });
});

describe('expandAliases — CoRE Stack v3 domain terms', () => {
  it('bridges aquifer <-> groundwater / hydrogeology', () => {
    const out = expandAliases('Aquifers (CGWB)').toLowerCase();
    expect(out).toContain('groundwater');
    expect(out).toContain('water table');
  });
  it('bridges groundwater -> aquifer so either query finds both layers', () => {
    expect(expandAliases('groundwater extraction').toLowerCase()).toContain('aquifer');
  });
  it('bridges canal -> irrigation', () => {
    expect(expandAliases('Canals (WRIS)').toLowerCase()).toContain('irrigation');
  });
  it('bridges agro-ecological and agro-climatic to farming terms', () => {
    expect(expandAliases('Agro-Ecological Zones').toLowerCase()).toContain('agriculture');
    expect(expandAliases('Agro-Climatic Zones').toLowerCase()).toContain('agriculture');
  });
  it('bridges biogeographic -> ecoregion / ecology', () => {
    const out = expandAliases('Biogeographic Zones').toLowerCase();
    expect(out).toContain('ecology');
  });
});

describe('buildBodyHaystack — folds per-layer tags into the search body', () => {
  const layer = {
    description: 'Principal aquifer systems of India.',
    notes: 'Sourced via CoRE Stack.',
    source: 'CGWB',
    licence: 'GODL-India',
    category: 'water',
    tags: ['groundwater', 'water table', 'borewell'],
  };
  it('includes the tag terms in the body string', () => {
    const body = buildBodyHaystack(layer).toLowerCase();
    expect(body).toContain('groundwater');
    expect(body).toContain('borewell');
  });
  it('includes description + source + category', () => {
    const body = buildBodyHaystack(layer).toLowerCase();
    expect(body).toContain('principal aquifer');
    expect(body).toContain('cgwb');
    expect(body).toContain('water');
  });
  it('does not break when tags are absent', () => {
    const body = buildBodyHaystack({ description: 'x', source: 'LGD' });
    expect(typeof body).toBe('string');
  });
});
