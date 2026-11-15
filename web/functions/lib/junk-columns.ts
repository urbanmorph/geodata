// GIS artefact columns (shape lengths/areas, simplification flags, OGR ids)
// that carry nothing a reader wants. Lowercase names; compare lowercased.
// locate and nearby keep OBJECTID-style ids: the map's "Zoom to it" highlight
// matches the located feature on its properties, and the id is often the only
// unique one. The query engine also hides those ids (QUERY_JUNK_COLUMNS).
export const GIS_ARTEFACT_COLUMNS: ReadonlySet<string> = new Set([
  'shape_leng', 'shape_area', 'shape_length', 'shape.starea()', 'shape.stlength()',
  'shape_le_1', 'st_area(shape)', 'st_perimeter(shape)',
  'inpoly_fid', 'simpgnflag', 'maxsimptol', 'minsimptol', 'ogc_fid',
]);

export const QUERY_JUNK_COLUMNS: ReadonlySet<string> = new Set([
  ...GIS_ARTEFACT_COLUMNS, 'objectid', 'objectid_1', 'objectid_2', 'objectid_3',
]);
