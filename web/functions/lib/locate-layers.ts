// The layers /api/v1/locate checks when the caller names none (plus the city ward layer
// covering the point). No imports, so the build (prerender) can read it too.
export const DEFAULT_LOCATE_LAYERS = [
  'lgd_states', 'lgd_districts', 'lgd_subdistricts', 'lgd_blocks',
  'lgd_parliament', 'lgd_assembly',
  'bharatviz_pincodes', 'seismic_zones',
  'wris_basins', 'soi_forests', 'gs_wildlife', 'bm_eco_zones',
  'high_courts',
] as const;
