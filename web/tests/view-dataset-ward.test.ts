import { describe, it, expect } from 'vitest';
import { wardSeo } from '../functions/lib/view-dataset';

// Ward pages are the #1 search intent. wardSeo turns the dataset-framed
// seo_title into a task-framed snippet + HowTo matching the real GSC queries.
// It must NEVER promise an area name the layer doesn't carry — the original
// seo_description's "boundaries and names" vs "…and numbers" wording is the cue.

const NAMED = 'Interactive map of all 24 wards in Mumbai (BMC). View ward boundaries and names, filter by ward.';
const NUMBERED = 'Interactive map of all 200 wards in Chennai (GCC). View ward boundaries and numbers, filter by ward.';

describe('wardSeo', () => {
  it('claims area names ONLY when the layer has them', () => {
    const named = wardSeo('Mumbai Ward Map: 24 wards (BMC)', '24', NAMED);
    expect(named.description).toContain('your ward number and name');
    expect(named.description).toContain('24 Mumbai wards with area names');

    const numbered = wardSeo('Chennai Ward Map: 200 wards (GCC)', '200', NUMBERED);
    expect(numbered.description).toContain('your ward number.'); // no "and name"
    expect(numbered.description).not.toContain('and name');
    expect(numbered.description).not.toContain('area names');
    expect(numbered.description).toContain('200 Chennai wards,');
  });

  it('matches the real query language in both cases', () => {
    for (const d of [
      wardSeo('Mumbai Ward Map: 24 wards (BMC)', '24', NAMED).description,
      wardSeo('Chennai Ward Map: 200 wards (GCC)', '200', NUMBERED).description,
    ]) {
      expect(d).toContain('Which ward is your location in?'); // which ward is my location
      expect(d).toContain('ward number'); // ward number
    }
  });

  it('keeps every real ward snippet within the 158-char SERP cap', () => {
    const cases: Array<[string, string, string]> = [
      ['Chennai Ward Map: 200 wards (GCC)', '200', NUMBERED],
      ['Mumbai Ward Map: 24 wards (BMC)', '24', NAMED],
      ['BBMP Ward Map: 243 wards (Bengaluru, 2022)', '243', ''],
      ['Visakhapatnam Ward Map: 98 wards (GVMC)', '98', NUMBERED],
    ];
    for (const [t, c, od] of cases) expect(wardSeo(t, c, od).description.length).toBeLessThanOrEqual(158);
  });

  it('reflects names/numbers in the HowTo final step + keys it to the place', () => {
    const named = wardSeo('Mumbai Ward Map: 24 wards (BMC)', '24', NAMED);
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
