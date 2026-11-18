// GeoJSON/KML filtered exports are back on (paused 18 Nov 2026 when production
// cut the streams off after the opening line; shapes are now streamed and
// decoded per matching row, parquet-column-stream.ts). A stream that fails
// partway must fail visibly, never end as a short file under a 200.
import { describe, it, expect } from 'vitest';
import { exportBody, shapeExportRefusal } from '../functions/api/v1/layers/[id]/export';
import { SERVER_SHAPE_EXPORT } from '../../shared/large-load.mjs';
import { overCapMessage } from '../src/filter';

describe('filtered shape exports', () => {
  it('are on: geojson, kml and csv are all served', () => {
    expect(SERVER_SHAPE_EXPORT).toBe(true);
    for (const f of ['geojson', 'kml', 'csv']) expect(shapeExportRefusal(f)).toBeNull();
  });

  it('a failure partway errors the response body instead of ending it cleanly', async () => {
    async function* chunks() {
      yield '{"type":"FeatureCollection","features":[';
      throw new Error('boom');
    }
    const reader = exportBody(chunks()).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('FeatureCollection');
    await expect(reader.read()).rejects.toThrow(/boom/);
  });

  it('a complete export ends cleanly', async () => {
    async function* chunks() { yield 'a'; yield 'b'; }
    expect(await new Response(exportBody(chunks())).text()).toBe('ab');
  });

  it('a client that goes away stops the export', async () => {
    let stopped = false;
    async function* chunks() {
      try { for (;;) yield 'x'; } finally { stopped = true; }
    }
    const reader = exportBody(chunks()).getReader();
    await reader.read();
    await reader.cancel();
    expect(stopped).toBe(true);
  });

  it('the panel says when shapes would take too much decoding, for GeoJSON/KML only', () => {
    const one = [{ col: 'sname', kind: 'in', values: ['SK'] }] as never;
    const huge = 2 * 1024 ** 3;
    expect(overCapMessage(10, 1000, 'geojson', one, true, huge)).toMatch(/CSV/);
    expect(overCapMessage(10, 1000, 'kml', one, true, huge)).toMatch(/CSV/);
    expect(overCapMessage(10, 1000, 'csv', one, true, huge)).toBeNull();
    expect(overCapMessage(10, 1000, 'geojson', one, true, 1000)).toBeNull();
  });
});
