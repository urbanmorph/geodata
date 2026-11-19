// Per-layer "Find my location" config: whether the locate item shows in the
// bottom bar, its short toolbar label, and the spatial mode the endpoint should
// use. Explicit per-layer config (curated `level_meta`, or a baked community
// layer) wins; for Step 1a ward layers are auto-enabled as a built-in so the
// feature lights up without a catalog change. 1b+ turns on more layers by
// adding `locate_label` (+ optional `locate_mode`) to their level_meta — no code.
import { isWardLayer } from './locate-actions';

export type LocateMode = 'contains' | 'nearest';
export type LocateConfig = { label: string; mode: LocateMode };

export type LocateLayer = { id: string; level?: string | null; name?: string | null };
export type LocateLevelMeta =
  | { locate_label?: string | null; locate_mode?: string | null }
  | null
  | undefined;


// Arrival zoom for the locate "Zoom to it", keyed by layer level. A best-effort
// fitBounds then tightens to the actual feature; this just gets close enough
// that the feature's tiles are loaded for that fit. Wards 13, else 11.
const LEVEL_ZOOM: Record<string, number> = {
  state: 6, district: 9, subdistrict: 10, block: 11, panchayat: 12, village: 13,
  assembly_constituency: 9, parliament_constituency: 8, seismic_zone: 7, eco_zone: 7,
  health_facility: 14, airport: 11,
};

export function arrivalZoom(level: string | null): number {
  if (!level) return 11;
  const z = LEVEL_ZOOM[level]; // own-prop number, or inherited junk like toString
  if (typeof z === 'number') return z;
  return isWardLayer(level) ? 13 : 11;
}

// Built-in locate config keyed by the layer's `level` (mirrors the edge's
// shared/level-meta.mjs keys). These admin / zone layers partition space, so
// "which one contains me" is meaningful, and all are point-in-polygon. `state`
// is omitted on purpose — "which state am I in" is rarely a real question. Any
// layer can still override via level_meta.locate_label.
const LEVEL_LOCATE: Record<string, LocateConfig> = {
  district: { label: 'My district', mode: 'contains' },
  subdistrict: { label: 'My taluk', mode: 'contains' },
  block: { label: 'My block', mode: 'contains' },
  panchayat: { label: 'My panchayat', mode: 'contains' },
  village: { label: 'My village', mode: 'contains' },
  assembly_constituency: { label: 'My MLA', mode: 'contains' },
  parliament_constituency: { label: 'My MP', mode: 'contains' },
  seismic_zone: { label: 'Seismic zone', mode: 'contains' },
  eco_zone: { label: 'Eco-zone', mode: 'contains' },
  // 1c: point layers use `nearest` (a GPS fix is never *inside* a point) — the
  // endpoint returns the closest feature + distance + bearing.
  health_facility: { label: 'Health nearby', mode: 'nearest' },
  airport: { label: 'Nearest airport', mode: 'nearest' },
};

export function resolveLocateConfig(layer: LocateLayer, levelMeta?: LocateLevelMeta): LocateConfig | null {
  const label = levelMeta?.locate_label?.trim();
  if (label) {
    return { label, mode: levelMeta?.locate_mode === 'nearest' ? 'nearest' : 'contains' };
  }
  if (layer.level != null) {
    const byLevel = LEVEL_LOCATE[layer.level];
    if (byLevel) return { ...byLevel };
    // Ward layers' level IS the layer id (e.g. "wards_bengaluru_bbmp_2022").
    if (isWardLayer(layer.level)) return { label: 'My ward', mode: 'contains' };
  }
  if (isWardLayer(layer.id)) return { label: 'My ward', mode: 'contains' };
  return null;
}
