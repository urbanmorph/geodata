import { describe, it, expect } from 'vitest';
import { classifyKey } from '../functions/lib/r2-keys';

describe('classifyKey — curated admin layers', () => {
  it('classifies an LGD parquet at the states level', () => {
    expect(classifyKey('admin/states/LGD_States.parquet')).toEqual({
      layer_id: 'lgd_states',
      state_code: '',
      format: 'parquet',
    });
  });

  it('classifies an LGD pmtiles at the villages level', () => {
    expect(classifyKey('admin/villages/LGD_Villages.pmtiles')).toEqual({
      layer_id: 'lgd_villages',
      state_code: '',
      format: 'pmtiles',
    });
  });

  it('classifies SOI / Bhuvan / PMGSY variants', () => {
    expect(classifyKey('admin/districts/SOI_Districts.parquet')?.layer_id).toBe('soi_districts');
    expect(classifyKey('admin/blocks/bhuvan_blocks.parquet')?.layer_id).toBe('bhuvan_blocks');
    expect(classifyKey('admin/blocks/PMGSY_Blocks.parquet')?.layer_id).toBe('pmgsy_blocks');
  });
});

describe('classifyKey — pre-baked per-state extracts', () => {
  it('classifies a district-level state extract', () => {
    expect(classifyKey('extracts/districts/29/districts_ka.parquet')).toEqual({
      layer_id: 'lgd_districts',
      state_code: '29',
      format: 'parquet',
    });
  });

  it('classifies a village-level state extract in geojson', () => {
    expect(classifyKey('extracts/villages/19/villages_wb.geojson')).toEqual({
      layer_id: 'lgd_villages',
      state_code: '19',
      format: 'geojson',
    });
  });

  it('classifies a sub-district KML', () => {
    expect(classifyKey('extracts/subdistricts/07/subdistricts_dl.kml')).toEqual({
      layer_id: 'lgd_subdistricts',
      state_code: '07',
      format: 'kml',
    });
  });
});

describe('classifyKey — community submissions', () => {
  it('classifies a community key by its nanoid', () => {
    expect(classifyKey('community/Xa9Kp7nB/bangalore_bike_lanes.geojson')).toEqual({
      layer_id: 'c_Xa9Kp7nB',
      state_code: '',
      format: 'geojson',
    });
  });
});

describe('classifyKey — geoBoundaries cross-check', () => {
  it('classifies a geoBoundaries file as its admin level', () => {
    expect(classifyKey('geoboundaries/IND_ADM1.geojson')).toEqual({
      layer_id: 'gb_adm1',
      state_code: '',
      format: 'geojson',
    });
  });
});

describe('classifyKey — legacy boundaries layout', () => {
  it('classifies the CG/JH/OD legacy state extracts', () => {
    expect(classifyKey('boundaries/districts/lgd_districts_cg.geojson')).toEqual({
      layer_id: 'lgd_districts',
      state_code: 'cg',
      format: 'geojson',
    });
  });
});

describe('classifyKey — unrecognised paths', () => {
  it('returns null for empty / malformed input', () => {
    expect(classifyKey('')).toBeNull();
    expect(classifyKey('random.txt')).toBeNull();
    expect(classifyKey('admin/')).toBeNull();
    expect(classifyKey('admin/states/file.with.no.ext.')).toBeNull();
  });
});
