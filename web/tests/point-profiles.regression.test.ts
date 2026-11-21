import { describe, it, expect } from 'vitest';

// The 9-point regression check for /api/v1/ground and /api/v1/surface (plan F11).
// It asks a running server, so it is skipped unless POINT_PROFILES_URL names one:
//
//   cd web && npx wrangler pages dev dist --port 8833          # R2 must reach the real bucket
//   POINT_PROFILES_URL=http://localhost:8833 npx vitest run tests/point-profiles.regression.test.ts
//
// (or a deployed preview with POINT_PROFILES=on). Each point checks that every section
// answers and that its landmark values hold: the rock unit, the aquifer, the river within
// a few km. A layer that times out on a slow link is reported, not failed, unless
// POINT_PROFILES_STRICT=1 (the release gate: complete answers).

const BASE = process.env.POINT_PROFILES_URL;
const STRICT = process.env.POINT_PROFILES_STRICT === '1';

type Entry = { status: string; features?: Record<string, unknown>[]; nearest?: Array<{ distance_km: number; properties: Record<string, unknown> }>; values?: Record<string, unknown> | null; decoded?: Record<string, unknown>; stats?: Record<string, number | null> };
type Profile = { summary: string; sections: Record<string, Record<string, Entry>>; unavailable: Array<{ layer_id: string; reason: string }> };

async function get(kind: 'ground' | 'surface', lat: number, lng: number): Promise<Profile> {
  // Sent as our own smoke test, so the check is not counted as use (usage.ts).
  const r = await fetch(`${BASE}/api/v1/${kind}?lat=${lat}&lng=${lng}`, { headers: { 'user-agent': 'bharatlas-mcp-test point-profiles' } });
  expect(r.status, `${kind} ${lat},${lng}`).toBe(200);
  return r.json() as Promise<Profile>;
}
const feat = (e: Entry | undefined, k: string) => String(e?.features?.[0]?.[k] ?? '');
const cover = (s: Profile['sections']) => s.land.worldcover?.values?.land_cover;
const near = (e: Entry | undefined) => e?.nearest?.[0];

interface Point {
  lat: number; lng: number;
  ground: (g: Profile['sections']) => void;
  surface: (s: Profile['sections']) => void;
}

const POINTS: Record<string, Point> = {
  delhi: { lat: 28.525, lng: 77.085,
    ground: (g) => {
      expect(feat(g.seismic.seismic_zones, 'seismic_zo')).toBe('Seismic Zone-IV');
      expect(feat(g.geology.gsi_lithology_50k, 'lithologic')).toMatch(/SILT-CLAY/);
      expect(g.subsidence.subsidence_megacities.status).toBe('found');
    },
    surface: (s) => {
      expect(feat(s.place.lgd_districts, 'dtname')).toBe('South West');
      expect(cover(s)).toBe('Built-up');
      expect(near(s.access.gs_highways)!.distance_km).toBeLessThan(3);
    } },
  joshimath: { lat: 30.555, lng: 79.565,
    ground: (g) => {
      expect(feat(g.seismic.seismic_zones, 'seismic_zo')).toBe('Seismic Zone-V');
      expect(g.subsidence.subsidence_megacities.status).toBe('not_covered');
    },
    surface: (s) => {
      expect(Number(s.land.dem.values!.elevation_m)).toBeGreaterThan(1500);
      expect(cover(s)).toBe('Built-up');
      expect(String(near(s.water.wris_rivers)!.properties.rivname)).toMatch(/Alaknanda/);
    } },
  mahabaleshwar: { lat: 17.925, lng: 73.657,
    ground: (g) => expect(feat(g.geology.gsi_lithology_50k, 'lithologic')).toMatch(/LATERITE/),
    surface: (s) => {
      expect(Number(s.land.dem.values!.elevation_m)).toBeGreaterThan(1200);
      expect(cover(s)).toBe('Built-up');
    } },
  latur: { lat: 18.40, lng: 76.58,
    ground: (g) => expect(feat(g.geology.gsi_lithology_50k, 'lithologic')).toMatch(/BASALT/),
    surface: (s) => {
      expect(feat(s.place.lgd_districts, 'dtname')).toBe('Latur');
      expect(cover(s)).toBe('Built-up');
    } },
  jaisalmer: { lat: 26.915, lng: 70.908,
    ground: (g) => expect(feat(g.groundwater.cgwb_aquifers, 'aquifer')).toBe('Sandstone'),
    surface: (s) => {
      expect(feat(s.place.lgd_districts, 'dtname')).toBe('Jaisalmer');
      expect(cover(s)).toBe('Built-up');
    } },
  majuli: { lat: 26.95, lng: 94.17,
    ground: (g) => expect(feat(g.seismic.seismic_zones, 'seismic_zo')).toBe('Seismic Zone-V'),
    surface: (s) => {
      const r = near(s.water.wris_rivers)!;
      expect(String(r.properties.rivname)).toMatch(/Brahmaputra/);
      expect(r.distance_km).toBeLessThan(5);
      expect(s.water.ndem_floods_1998_2022.status).toBe('found');
      expect(cover(s)).toBe('Cropland');
    } },
  kolkata: { lat: 22.57, lng: 88.36,
    ground: (g) => expect(feat(g.groundwater.cgwb_aquifers, 'aquifer')).toBe('Alluvium'),
    surface: (s) => {
      const r = near(s.water.wris_rivers)!;
      expect(String(r.properties.rivname)).toMatch(/Hooghly/);
      expect(r.distance_km).toBeLessThan(3);
      expect(cover(s)).toBe('Built-up');
    } },
  bengaluru: { lat: 12.97, lng: 77.59,
    ground: (g) => expect(feat(g.geology.gsi_lithology_50k, 'lithologic')).toMatch(/GRANITE/),
    // 12.97, 77.59 falls in Cubbon Park: tree cover, as ESA's 10 m map also says
    surface: (s) => {
      expect(feat(s.place.lgd_districts, 'dtname')).toBe('Bengaluru Urban');
      expect(cover(s)).toBe('Tree cover');
    } },
  bhuj: { lat: 23.25, lng: 69.67,
    ground: (g) => expect(feat(g.seismic.seismic_zones, 'seismic_zo')).toBe('Seismic Zone-V'),
    surface: (s) => {
      expect(feat(s.place.lgd_districts, 'dtname')).toBe('Kachchh');
      expect(cover(s)).toBe('Built-up');
    } },
};

const GROUND_SECTIONS = ['seismic', 'geology', 'resources', 'groundwater', 'soil', 'subsidence', 'underground', 'watershed'];
const SURFACE_SECTIONS = ['place', 'land', 'climate', 'water', 'hazards', 'protected', 'access', 'services', 'infrastructure'];
// Lasting gaps, not failures: rasters whose file is not published (none now; kept for new ones).
const LASTING = /not published/;

describe.skipIf(!BASE)('point profiles at the 9 test points', () => {
  for (const [name, p] of Object.entries(POINTS)) {
    for (const kind of ['ground', 'surface'] as const) {
      it(`${kind} ${name}`, async () => {
        const r = await get(kind, p.lat, p.lng);
        expect(Object.keys(r.sections)).toEqual(kind === 'ground' ? GROUND_SECTIONS : SURFACE_SECTIONS);
        expect(r.summary.length).toBeGreaterThan(40);
        const missed = r.unavailable.filter((u) => !LASTING.test(u.reason));
        if (STRICT) expect(missed, 'layers that did not answer').toEqual([]);
        else if (missed.length) console.warn(`${kind} ${name}: unavailable`, missed);
        (kind === 'ground' ? p.ground : p.surface)(r.sections);
      }, 120_000);
    }
  }
});
