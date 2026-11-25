// GIS artefact columns (shape lengths/areas, simplification flags, OGR ids)
// that carry nothing a reader wants. Lowercase names; compare lowercased.
// locate and nearby keep OBJECTID-style ids: the map's "Zoom to it" highlight
// matches the located feature on its properties, and the id is often the only
// unique one. The query engine also hides those ids (QUERY_JUNK_COLUMNS).
export const GIS_ARTEFACT_COLUMNS: ReadonlySet<string> = new Set([
  'shape_leng', 'shape_area', 'shape_length', 'shape.starea()', 'shape.stlength()',
  'shape_le_1', 'st_area(shape)', 'st_perimeter(shape)',
  'inpoly_fid', 'simpgnflag', 'maxsimptol', 'minsimptol', 'ogc_fid',
  // a converted file's locator fields (biogeographic_zones): ids and 2009 dates, not the source's attributes
  '__mlocate_', '__mlocate0', '__mlocate1', '__mlocate2', '__mlocate3', '__mlocate4', '__mlocate5', '__mlocate6', '__mlocate7', '__mlocate8',
]);

export const QUERY_JUNK_COLUMNS: ReadonlySet<string> = new Set([
  ...GIS_ARTEFACT_COLUMNS, 'objectid', 'objectid_1', 'objectid_2', 'objectid_3',
]);
