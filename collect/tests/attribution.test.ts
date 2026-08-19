import { describe, it, expect } from 'vitest';
import { composeAttribution } from '../src/publish/attribution';

describe('composeAttribution', () => {
  it('composes the OSM-style credit line and per-name breakdown', () => {
    const names = ['Dinesh', 'Dinesh', 'Asha', null, '', 'Dinesh'];
    const { line, contributors } = composeAttribution('Bengaluru Footpaths', 'CC-BY-4.0', names);
    expect(line).toBe('Bengaluru Footpaths — 2 contributors + anonymous (CC-BY-4.0)');
    expect(contributors).toEqual([
      { name: 'Dinesh', records: 3 },
      { name: 'Asha', records: 1 },
      { name: 'anonymous', records: 2 },
    ]);
  });

  it('handles a single named contributor (singular)', () => {
    const { line, contributors } = composeAttribution('Survey', 'CC0-1.0', ['Asha', 'Asha']);
    expect(line).toBe('Survey — 1 contributor (CC0-1.0)');
    expect(contributors).toEqual([{ name: 'Asha', records: 2 }]);
  });

  it('handles all-anonymous', () => {
    const { line, contributors } = composeAttribution('Survey', 'ODbL-1.0', [null, '', '  ']);
    expect(line).toBe('Survey — anonymous contributors (ODbL-1.0)');
    expect(contributors).toEqual([{ name: 'anonymous', records: 3 }]);
  });

  it('sorts named contributors by record count desc, then name', () => {
    const { contributors } = composeAttribution('S', 'CC-BY-4.0', ['B', 'A', 'A', 'C', 'C']);
    expect(contributors.map((c) => c.name)).toEqual(['A', 'C', 'B']);
  });

  it('credits distinct imported sources alongside field contributors', () => {
    const r = composeAttribution('Trees', 'CC-BY-4.0', ['Asha', null], ['SOI Atlas', 'SOI Atlas', 'FSI']);
    expect(r.sources).toEqual(['SOI Atlas', 'FSI']);
    expect(r.line).toBe('Trees — 1 contributor + anonymous (CC-BY-4.0). Includes data from SOI Atlas, FSI');
  });

  it('names the source even when there are no field contributors', () => {
    const r = composeAttribution('Trees', 'CC-BY-4.0', [], ['FSI']);
    expect(r.line).toBe('Trees (CC-BY-4.0). Includes data from FSI');
  });
});
