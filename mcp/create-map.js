// create_map's request to collect. Every map carries a licence: CC0 when the caller names none,
// and the answer says which licence the map got, so the person is told (owner, 2026-11-20).
export const DEFAULT_LICENCE = "CC0-1.0";

export function createMapBody(args) {
  const schema_doc = { version: 1, geometry: args.geometry, fields: args.fields };
  if (args.category) schema_doc.category = args.category;
  if (args.basemap) schema_doc.basemap = args.basemap;
  if (args.mode && args.mode !== "form") schema_doc.mode = args.mode;
  const license = args.license || DEFAULT_LICENCE;
  const body = {
    name: args.name, purpose: args.purpose, description: args.description,
    license, data_year: args.data_year,
    moderation: args.moderation === false ? 0 : 1, schema_doc,
  };
  const licenceNote = args.license
    ? `Licence: ${license}.`
    : `Licence: ${license} (public domain), the default because none was given. Tell the person; ` +
      "they can choose another open licence in the map's settings before the map has points.";
  return { body, licenceNote };
}
