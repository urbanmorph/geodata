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

export function resolveLocateConfig(layer: LocateLayer, levelMeta?: LocateLevelMeta): LocateConfig | null {
  const label = levelMeta?.locate_label?.trim();
  if (label) {
    return { label, mode: levelMeta?.locate_mode === 'nearest' ? 'nearest' : 'contains' };
  }
  // 1a built-in: ward layers (id or level starts with "wards_") = contains.
  if (WARD_RE.test(layer.id) || (layer.level != null && WARD_RE.test(layer.level))) {
    return { label: 'My ward', mode: 'contains' };
  }
  return null;
}
