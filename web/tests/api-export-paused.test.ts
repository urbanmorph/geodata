// GeoJSON/KML filtered exports are paused (18 Nov 2026): production cut the
// streams off after the opening line. The API says so instead of sending a
// broken file; CSV keeps working.
import { describe, it, expect } from 'vitest';
import { shapeExportRefusal } from '../functions/api/v1/layers/[id]/export';

describe('filtered shape exports while paused', () => {
  it('refuses geojson and kml with guidance, allows csv', () => {
    expect(shapeExportRefusal('geojson')).toMatch(/format=csv/);
    expect(shapeExportRefusal('geojson')).toMatch(/download/i);
    expect(shapeExportRefusal('kml')).toMatch(/format=csv/);
    expect(shapeExportRefusal('csv')).toBeNull();
  });
});
