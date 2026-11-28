// A requested layer's credit ("Requested by" on the list, "Curated by bharatlas at the request of"
// on the About panel) and the rule that a requested (paid) layer never uses non-commercial sources.
import { describe, expect, it } from 'vitest';
import {
  requestedBy, requestedByTagHtml, requestedByAboutHtml, requestedLayersThatAreNonCommercial,
} from '../../shared/requested-by.mjs';
import catalog from '../../catalog.json';

const pesa = { id: 'scheduled_areas_fifth', licence: 'CC0-1.0', requested_by: { name: 'Sandilya MV' } };

describe('requested-by credit', () => {
  it('reads the requester, and nothing for a layer no one requested', () => {
    expect(requestedBy(pesa)).toEqual({ name: 'Sandilya MV', line: '' });
    expect(requestedBy({ id: 'x' })).toBeNull();
    expect(requestedBy({ id: 'x', requested_by: { name: '  ' } })).toBeNull();
  });

  it('tags the list row "Requested by" and escapes the name', () => {
    expect(requestedByTagHtml(pesa)).toContain('Requested by Sandilya MV');
    expect(requestedByTagHtml({ id: 'x', requested_by: { name: '<b>A</b>' } })).toContain('&lt;b&gt;A&lt;/b&gt;');
    expect(requestedByTagHtml({ id: 'x' })).toBe('');
  });

  it('says "Curated by bharatlas at the request of" on the About panel, with the line only when given', () => {
    const html = requestedByAboutHtml(pesa);
    expect(html).toContain('Curated by bharatlas at the request of Sandilya MV');
    expect(html).toContain('href="/docs#request"');
    expect(html).not.toContain('about-panel__req-line');
    expect(requestedByAboutHtml({ ...pesa, requested_by: { name: 'A', line: 'For gram sabhas' } }))
      .toContain('For gram sabhas');
    expect(requestedByAboutHtml({ id: 'x' })).toBe('');
  });
});

describe('a requested layer is never non-commercial', () => {
  it('flags a requested layer whose licence or source is non-commercial', () => {
    expect(requestedLayersThatAreNonCommercial([
      pesa,
      { id: 'nc', licence: 'CC-BY-NC-4.0', requested_by: { name: 'A' } },
      { id: 'nc2', licence: 'CC-BY-4.0', non_commercial: true, requested_by: { name: 'B' } },
      { id: 'free', licence: 'CC-BY-NC-4.0' },
    ])).toEqual(['nc', 'nc2']);
  });

  it('holds for every layer in the catalog', () => {
    expect(requestedLayersThatAreNonCommercial((catalog as { layers: object[] }).layers)).toEqual([]);
  });
});
