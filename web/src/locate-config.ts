// Per-layer "Find my location" config: whether the locate item shows in the
// bottom bar, its short toolbar label, and the spatial mode the endpoint should
// use. Explicit per-layer config (curated `level_meta`, or a baked community
// layer) wins; for Step 1a ward layers are auto-enabled as a built-in so the
// feature lights up without a catalog change. 1b+ turns on more layers by
// adding `locate_label` (+ optional `locate_mode`) to their level_meta — no code.

export type LocateMode = 'contains' | 'nearest';
export type LocateConfig = { label: string; mode: LocateMode };

export type LocateLayer = { id: string; level?: string | null; name?: string | null };
export type LocateLevelMeta =
  | { locate_label?: string | null; locate_mode?: string | null }
  | null
  | undefined;

const WARD_RE = /^wards_/;

// Built-in locate config keyed by the layer's `level` (mirrors the edge's
// BUILTIN_LEVEL_META keys). These admin / zone layers partition space, so
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
    if (WARD_RE.test(layer.level)) return { label: 'My ward', mode: 'contains' };
  }
  if (WARD_RE.test(layer.id)) return { label: 'My ward', mode: 'contains' };
  return null;
}
