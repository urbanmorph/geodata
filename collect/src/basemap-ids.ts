// The basemap ids a map can name (schema_doc.basemap), apart from basemap.ts so
// the server's validator can check them without loading MapLibre.
export const BASEMAP_IDS = ['liberty', 'osm', 'opentopo', 'satellite'] as const;
export type BasemapId = (typeof BASEMAP_IDS)[number];
/** Ids older maps were saved with; basemap.ts normalizeBasemap reads them as today's. */
export const RETIRED_BASEMAP_IDS = ['positron', 'topo'] as const;
export const isBasemapId = (v: unknown): boolean =>
  ([...BASEMAP_IDS, ...RETIRED_BASEMAP_IDS] as readonly unknown[]).includes(v);
