// The home page's India map: one outline (the share cards' INDIA_PATH), city
// ward markers made at build time from the ward bounding boxes, and four more
// themes (rail, water, schools, forests) in /map-themes.json. A picture, not a
// working map: each visit shows 2 or 3 themes at random, named in the caption
// (owner, 2026-11-21); no theme switch.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: plain .mjs
import { project, wardCities, hexPath, mapThemes, indiaMapHtml, lightenPath, MAP_VIEWBOX } from '../scripts/india-map.mjs';
import { INDIA_PATH } from '../functions/lib/og-india-path';
import { WARD_BBOXES } from '../functions/lib/ward-bboxes';
import { themeMarkup, pickThemes, captionHtml, layerMarkup, DENSE } from '../src/india-map';

const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../catalog.json'), 'utf8'));
const themesFile = JSON.parse(readFileSync(resolve(__dirname, '../public/map-themes.json'), 'utf8'));

describe('project', () => {
  it('uses the share-card frame, so data lines up with INDIA_PATH', () => {
    // The frame's corners: 67.5°E, 38°N is the top-left of the fitted box.
    const [x0, y0] = project(67.5, 38);
    expect(x0).toBeCloseTo(91.08, 1);
    expect(y0).toBeCloseTo(75, 5);
    const [x1, y1] = project(98.5, 5.5);
    expect(x1 - x0).toBeCloseTo(31 * (480 / 32.5), 3);
    expect(y1 - y0).toBeCloseTo(480, 3);
  });
});

describe('lightenPath', () => {
  it('keeps every shape of the outline (islands too) and roughly halves it', () => {
    const light = lightenPath(INDIA_PATH);
    expect(light.match(/M/g)).toHaveLength(INDIA_PATH.match(/M/g)!.length);
    expect(light.length).toBeLessThan(INDIA_PATH.length * 0.6);
  });
});

describe('wardCities', () => {
  const cities = wardCities(WARD_BBOXES);
  it('one marker per city: vintages of the same city collapse', () => {
    const layers = Object.keys(WARD_BBOXES).length;
    expect(cities.length).toBeLessThan(layers);
    // Bengaluru has two vintages with the same extent.
    const blr = WARD_BBOXES.wards_bengaluru_gba;
    const [bx, by] = project((blr[0] + blr[2]) / 2, (blr[1] + blr[3]) / 2);
    expect(cities.filter((c: { x: number; y: number }) => Math.hypot(c.x - bx, c.y - by) < 2)).toHaveLength(1);
  });
  it('bigger cities get bigger markers', () => {
    const r = (id: string) => {
      const b = WARD_BBOXES[id];
      const [x, y] = project((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
      return cities.find((c: { x: number; y: number }) => Math.hypot(c.x - x, c.y - y) < 2).r;
    };
    expect(r('wards_delhi')).toBeGreaterThan(r('wards_kochi'));
  });
  it('hexPath draws one closed hexagon per city', () => {
    const d = hexPath(cities);
    expect(d.match(/M/g)).toHaveLength(cities.length);
    expect(d.match(/z/g)).toHaveLength(cities.length);
  });
});

describe('mapThemes', () => {
  const themes = mapThemes(catalog, 31);
  it('five themes, wards first (the one that ships inline)', () => {
    expect(themes.map((t: { key: string }) => t.key)).toEqual(['wards', 'rail', 'rivers', 'schools', 'forests']);
  });
  it('each theme names itself and links to its layer\'s map', () => {
    for (const t of themes as { key: string; name: string; href: string }[]) {
      expect(t.name, t.key).toMatch(/^[a-z ]+$/);
      const id = t.href.match(/^\/view\/([a-z0-9_]+)$/)?.[1];
      if (t.key === 'wards') expect(t.href).toBe('/layers?q=wards');
      else expect(catalog.layers.some((l: { id: string }) => l.id === id), t.href).toBe(true);
    }
  });
  it('captions name the source and use the catalogue counts', () => {
    const cap = (k: string) => themes.find((t: { key: string }) => t.key === k).caption;
    expect(cap('wards')).toContain('31 cities');
    expect(cap('schools')).toContain('29,40,912');
    expect(cap('rail')).toContain('Indian Railways');
    expect(cap('rivers')).toContain('India-WRIS');
    expect(cap('forests')).toContain('Survey of India');
  });
});

describe('indiaMapHtml', () => {
  const html = indiaMapHtml({ wardBboxes: WARD_BBOXES, catalog });
  it('no theme switch: the themes ride along as data for the random pick', () => {
    expect(html).not.toMatch(/<button|data-map-theme=/);
    const data = JSON.parse(html.match(/data-themes="([^"]+)"/)![1].replace(/&quot;/g, '"'));
    expect(data.map((t: { key: string }) => t.key)).toEqual(['wards', 'rail', 'rivers', 'schools', 'forests']);
  });
  it('without JS the caption names what is drawn: the city wards, linked', () => {
    const cap = html.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/)![1];
    expect(cap).toMatch(/^Showing: <a href="\/layers\?q=wards"[^>]*>city wards<\/a>/);
  });
  it('ships the outline and the ward markers inline, and no other theme data', () => {
    expect(html).toContain(`viewBox="${MAP_VIEWBOX}"`);
    // The outline is defined once and reused (land, clip, edge), never copied.
    expect(html).toMatch(/<path id="india-shape" d="M101 287 /);
    expect(html.match(/M101 287 /g)).toHaveLength(1);
    expect(html).toContain('class="india-map__wards"');
    expect(html.length).toBeLessThan(16_000);
    expect(html).not.toContain(themesFile.rail.paths[0].slice(0, 40));
  });
});

describe('/map-themes.json (scripts/build_map_themes.py)', () => {
  it('has the four on-demand themes, each line or dense', () => {
    expect(Object.keys(themesFile).sort()).toEqual(['forests', 'rail', 'rivers', 'schools']);
    for (const t of Object.values(themesFile) as { kind: string; paths: string[] }[]) {
      expect(['line', 'dense']).toContain(t.kind);
      expect(t.paths.length).toBe(t.kind === 'line' ? 1 : 4);
    }
  });
  it('every absolute point falls inside the map frame', () => {
    const [vx, vy, vw, vh] = MAP_VIEWBOX.split(' ').map(Number);
    for (const t of Object.values(themesFile) as { paths: string[] }[]) {
      for (const m of t.paths.join('').matchAll(/M(-?[\d.]+) (-?[\d.]+)/g)) {
        expect(+m[1]).toBeGreaterThanOrEqual(vx - 10);
        expect(+m[1]).toBeLessThanOrEqual(vx + vw + 10);
        expect(+m[2]).toBeGreaterThanOrEqual(vy - 10);
        expect(+m[2]).toBeLessThanOrEqual(vy + vh + 10);
      }
    }
  });
});

type T = { key: string; name: string; href: string };
const T = (key: string): T => ({ key, name: key, href: `/view/${key}` });
const ALL = ['wards', 'rail', 'rivers', 'schools', 'forests'].map(T);

describe('pickThemes (client)', () => {
  it('picks 2 or 3, no repeats, at most one dense theme, and draws wards last', () => {
    for (let i = 0; i < 300; i++) {
      const p = pickThemes(ALL).map((t: T) => t.key);
      expect(p.length).toBeGreaterThanOrEqual(2);
      expect(p.length).toBeLessThanOrEqual(3);
      expect(new Set(p).size).toBe(p.length);
      expect(p.filter((k: string) => DENSE.has(k)).length).toBeLessThanOrEqual(1);
      // Legible at the map's size: lines vanish into shaded hexagons, so a hexagon
      // theme pairs only with the ward markers drawn on top of it.
      if (p.some((k: string) => DENSE.has(k))) expect(p.length === 2 && p[1] === 'wards').toBe(true);
      // Draw order: shaded hexagons under lines under the ward markers.
      const rank = (k: string) => (DENSE.has(k) ? 0 : k === 'wards' ? 2 : 1);
      expect(p.map(rank)).toEqual([...p.map(rank)].sort());
    }
  });
  it('varies from visit to visit', () => {
    const seen = new Set(Array.from({ length: 100 }, () => pickThemes(ALL).map((t: T) => t.key).sort().join()));
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe('captionHtml (client)', () => {
  it('names each theme shown, linked to its map', () => {
    expect(captionHtml([T('rail'), T('wards')])).toBe('Showing: <a href="/view/rail">rail</a> and <a href="/view/wards">wards</a>');
    expect(captionHtml([T('forests'), T('rivers'), T('wards')]))
      .toBe('Showing: <a href="/view/forests">forests</a>, <a href="/view/rivers">rivers</a> and <a href="/view/wards">wards</a>');
  });
});

describe('layerMarkup (client)', () => {
  it('stacks the fetched themes in the clip, then the inline ward markers', () => {
    const data = { rail: { kind: 'line' as const, paths: ['Mr'] }, forests: { kind: 'dense' as const, paths: ['M1', 'M2', 'M3', 'M4'] } };
    const svg = layerMarkup([T('forests'), T('rail'), T('wards')], data, '<path class="india-map__wards"/>')!;
    expect(svg.indexOf('dense--forests')).toBeLessThan(svg.indexOf('line--rail'));
    expect(svg.indexOf('line--rail')).toBeLessThan(svg.indexOf('india-map__wards'));
    expect(svg).toMatch(/^<g clip-path="url\(#india-clip\)">/);
    expect(layerMarkup([T('rail')], {}, '')).toBeNull(); // missing data: keep the default
  });
});

describe('themeMarkup (client)', () => {
  it('a line theme is one stroked path', () => {
    const svg = themeMarkup({ kind: 'line', paths: ['M1 2 3 4'] }, 'rail');
    expect(svg).toBe('<path class="india-map__line india-map__line--rail" d="M1 2 3 4"/>');
  });
  it('a dense theme is four shaded paths, lightest first', () => {
    const svg = themeMarkup({ kind: 'dense', paths: ['Ma', 'Mb', 'Mc', 'Md'] }, 'schools');
    expect(svg.match(/<path /g)).toHaveLength(4);
    expect(svg).toContain('india-map__shade--0');
    expect(svg).toContain('india-map__shade--3');
    expect(svg).toContain('india-map__dense--schools');
  });
});
