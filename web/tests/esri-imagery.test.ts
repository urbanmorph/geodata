import { describe, it, expect } from 'vitest';
import { esriImagerySource, ESRI_IMAGERY_HOST } from '../../shared/esri-imagery';

// Satellite (Esri World Imagery) for bharatlas and collect, licensed through an
// ArcGIS Location Platform API key. Without a key the option is not offered.

describe('Esri World Imagery source', () => {
  it('needs a key: none (or blank) means no satellite option at all', () => {
    expect(esriImagerySource(undefined)).toBeNull();
    expect(esriImagerySource('')).toBeNull();
    expect(esriImagerySource('   ')).toBeNull();
  });

  it('asks Esri\'s keyed imagery service, z/y/x order, with the key as a token', () => {
    const src = esriImagerySource(' AAPTk+ey/1= ')!;
    expect(src.type).toBe('raster');
    expect(src.tiles).toHaveLength(1);
    const url = src.tiles![0];
    expect(url.startsWith(`${ESRI_IMAGERY_HOST}/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=`)).toBe(true);
    // The key is trimmed and URL-encoded, so a + / = in it survives.
    expect(url.endsWith('?token=AAPTk%2Bey%2F1%3D')).toBe(true);
    expect(ESRI_IMAGERY_HOST).toBe('https://ibasemaps-api.arcgis.com');
  });

  it('credits Esri and the imagery sources as Esri lists them today', () => {
    const attr = esriImagerySource('k')!.attribution!;
    expect(attr).toContain('Powered by');
    expect(attr).toContain('Esri');
    expect(attr).toContain('Vantor');
    expect(attr).not.toContain('Maxar');
  });
});
