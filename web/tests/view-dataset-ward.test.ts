import { describe, it, expect } from 'vitest';
import { wardSeo } from '../functions/lib/view-dataset';

// Ward pages are the #1 search intent. wardSeo turns the dataset-framed
// seo_title into a task-framed snippet + HowTo that matches the real GSC
// queries (which ward is my location / [city] ward map / ward number+name /
// how to find my ward number in [city]). Snippet must stay ≤158 (SERP cap).

const REAL_TITLES: ReadonlyArray<[string, string]> = [
  ['Chennai Ward Map: 200 wards (GCC)', '200'],
  ['Mumbai Ward Map: 24 wards (BMC)', '24'],
  ['Hyderabad Ward Map: 145 wards (GHMC)', '145'],
  ['Kolkata Ward Map: 141 wards (KMC)', '141'],
  ['Bengaluru Ward Map: 369 wards (GBA 2025)', '369'],
  ['BBMP Ward Map: 243 wards (Bengaluru, 2022)', '243'],
  ['Visakhapatnam Ward Map: 98 wards (GVMC)', '98'],
];

describe('wardSeo', () => {
  it('builds a task-framed snippet matching the real query language', () => {
    const { description } = wardSeo('Chennai Ward Map: 200 wards (GCC)', '200');
    expect(description).toContain('Which ward is your location in?'); // "which ward is my location"
    expect(description).toContain('ward number and name'); // "ward no/name of my location"
    expect(description).toContain('200 Chennai wards'); // "[city] ward" + count
    expect(description).toContain('area names'); // "ward list area wise" / "ward N city"
    expect(description).toContain('free to view or download');
  });

  it('keeps every real ward snippet within the 158-char SERP cap', () => {
    for (const [title, count] of REAL_TITLES) {
      expect(wardSeo(title, count).description.length).toBeLessThanOrEqual(158);
    }
  });

  it('emits a HowTo keyed to "how to find my ward number in <place>"', () => {
    const { howTo } = wardSeo('Chennai Ward Map: 200 wards (GCC)', '200');
    expect(howTo['@type']).toBe('HowTo');
    expect(howTo.name).toBe('How to find your ward number in Chennai');
    const steps = howTo.step as Array<{ text: string }>;
    expect(steps).toHaveLength(3);
    expect(steps[1].text).toContain('My ward');
    expect(steps[0].text).toContain('Chennai Ward Map');
  });

  it('handles a corp-prefixed title (no city word) gracefully', () => {
    const { description, howTo } = wardSeo('BBMP Ward Map: 243 wards (Bengaluru, 2022)', '243');
    expect(description).toContain('243 BBMP wards');
    expect(howTo.name).toBe('How to find your ward number in BBMP');
  });

  it('tolerates a missing count', () => {
    expect(wardSeo('Chennai Ward Map', null).description).toContain('Chennai wards');
  });
});
