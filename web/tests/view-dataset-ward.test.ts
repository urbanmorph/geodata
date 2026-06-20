import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { wardSeo } from '../functions/lib/view-dataset';

// Ward pages are the #1 search intent. wardSeo turns the dataset-framed
// seo_title into a task-framed snippet + HowTo matching the real GSC queries.
// It must NEVER promise an area name the layer doesn't carry — the original
// seo_description's "boundaries and names" vs "…and numbers" wording is the cue.
// (Ahmedabad genuinely carries locality names like "Naroda"/"Bodakdev";
// Mumbai/Chennai carry only letter-codes/numbers — so they are the NUMBERS case.)

const NAMED = 'Interactive map of all 48 wards in Ahmedabad (AMC). View ward boundaries and names, filter by ward.';
const NUMBERED = 'Interactive map of all 200 wards in Chennai (GCC). View ward boundaries and numbers, filter by ward.';

describe('wardSeo', () => {
  it('claims area names ONLY when the layer has them', () => {
    const named = wardSeo('Ahmedabad Ward Map: 48 wards (AMC)', '48', NAMED);
    expect(named.description).toContain('your ward number and name');
    expect(named.description).toContain('48 Ahmedabad wards with area names');

    const numbered = wardSeo('Chennai Ward Map: 200 wards (GCC)', '200', NUMBERED);
    expect(numbered.description).toContain('your ward number.'); // no "and name"
    expect(numbered.description).not.toContain('and name');
    expect(numbered.description).not.toContain('area names');
    expect(numbered.description).toContain('200 Chennai wards,');
  });

  it('matches the real query language in both cases', () => {
    for (const d of [
      wardSeo('Ahmedabad Ward Map: 48 wards (AMC)', '48', NAMED).description,
      wardSeo('Chennai Ward Map: 200 wards (GCC)', '200', NUMBERED).description,
    ]) {
      expect(d).toContain('Which ward is your location in?'); // which ward is my location
      expect(d).toContain('ward number'); // ward number
    }
  });

  it('keeps a long-city NAMES snippet within the 158-char SERP cap', () => {
    // Stress the longest realistic place + the (longer) "with area names" tail.
    const cases: Array<[string, string, string]> = [
      ['Pimpri-Chinchwad Ward Map: 66 wards (PCMC)', '66', NAMED],
      ['Visakhapatnam Ward Map: 98 wards (GVMC)', '98', NAMED],
      ['Bhubaneshwar Ward Map: 67 wards (BMC)', '67', NAMED],
    ];
    for (const [t, c, od] of cases) expect(wardSeo(t, c, od).description.length).toBeLessThanOrEqual(158);
  });

  it('reflects names/numbers in the HowTo final step + keys it to the place', () => {
    const named = wardSeo('Ahmedabad Ward Map: 48 wards (AMC)', '48', NAMED);
    expect((named.howTo.step as Array<{ text: string }>)[2].text).toContain('ward number and name');
    const numbered = wardSeo('Chennai Ward Map: 200 wards (GCC)', '200', NUMBERED);
    expect((numbered.howTo.step as Array<{ text: string }>)[2].text).toBe('Your ward number appears on the map.');
    expect(numbered.howTo.name).toBe('How to find your ward number in Chennai');
  });

  it('defaults to conservative (no name claim) when the cue is absent', () => {
    const d = wardSeo('BBMP Ward Map: 243 wards (Bengaluru, 2022)', '243', '').description;
    expect(d).toContain('243 BBMP wards,');
    expect(d).not.toContain('area names');
    expect(d).not.toContain('and name');
  });

  it('tolerates a missing count', () => {
    expect(wardSeo('Chennai Ward Map', null, NUMBERED).description).toContain('Chennai wards,');
  });
});

// Catalog-driven guards: these run wardSeo over the REAL catalog so a future
// new city (long name) or a re-introduced mislabel fails the build, not GSC.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const catalog = JSON.parse(readFileSync(resolve(ROOT, 'catalog.json'), 'utf8')) as {
  layers: Array<{ id: string; level?: string; name?: string; rows?: number }>;
  level_meta: Record<string, { seo_title?: string; label?: string; seo_description?: string }>;
};
const wardLayers = catalog.layers.filter((l) => /^wards_/.test(l.id));
const descFor = (l: (typeof wardLayers)[number]): string => {
  const m = catalog.level_meta[l.level || l.id] || {};
  const title = m.seo_title || m.label || l.name || l.id;
  const count = l.rows != null ? l.rows.toLocaleString('en-IN') : null;
  return wardSeo(title, count, m.seo_description).description;
};

describe('wardSeo over the real catalog', () => {
  it('every ward layer snippet stays within the 158-char SERP cap', () => {
    expect(wardLayers.length).toBeGreaterThan(20); // catalog actually loaded
    for (const l of wardLayers) {
      const d = descFor(l);
      expect(d.length, `${l.id}: "${d}" is ${d.length} chars`).toBeLessThanOrEqual(158);
    }
  });

  it('classification matches the data (no over/under-claims)', () => {
    const cls = (id: string) => {
      const l = wardLayers.find((x) => x.id === id);
      if (!l) throw new Error(`missing ward layer ${id}`);
      return /with area names/.test(descFor(l)) ? 'NAMES' : 'NUMBERS';
    };
    // Layers whose data carries real localities → must advertise area names.
    for (const id of ['wards_ahmedabad', 'wards_vadodara', 'wards_indore', 'wards_hyderabad',
      'wards_lucknow', 'wards_kochi', 'wards_pune', 'wards_bengaluru_gba', 'wards_bengaluru_bbmp_2022'])
      expect(cls(id), id).toBe('NAMES');
    // Layers carrying only ward numbers / letter-codes → must NOT claim names.
    for (const id of ['wards_mumbai', 'wards_patna', 'wards_chennai', 'wards_vizag',
      'wards_gurugram', 'wards_pcmc', 'wards_thane'])
      expect(cls(id), id).toBe('NUMBERS');
  });
});
