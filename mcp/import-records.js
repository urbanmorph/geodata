// import_points: give each record its client_id (the row's own id, scoped to
// the map) so re-running an import adds nothing and a corrected re-run updates
// rows in place. The server enforces it; this only picks the id out of the input.

const idText = (v) => {
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
};

/**
 * Where each record's client_id comes from, first match wins:
 * 1. `client_id` already on the record;
 * 2. with `clientIdField` (a non-empty string): that property;
 *    without it: the GeoJSON feature `id`, then an `id` property.
 * An empty `clientIdField` turns the default off. Records with no usable id are
 * sent without one (the server adds them again on a re-run).
 */
export function withClientIds(records, clientIdField) {
  return records.map((r) => {
    if (!r || typeof r !== "object" || r.client_id !== undefined) return r;
    const props = r.properties && typeof r.properties === "object" ? r.properties : {};
    const id = clientIdField === undefined || clientIdField === null
      ? idText(r.id) ?? idText(props.id)
      : clientIdField === "" ? undefined : idText(props[clientIdField]);
    return id === undefined ? r : { ...r, client_id: id };
  });
}

/** One line for the tool result: what the import did. */
export function importSummary(res, withoutId) {
  const refused = res.errors?.length ?? 0;
  return [
    `${res.added ?? res.imported ?? 0} added, ${res.updated ?? 0} updated, ${res.unchanged ?? 0} unchanged of ${res.total} rows${refused ? `; ${refused} refused (see errors)` : ""}.`,
    withoutId ? `${withoutId} row${withoutId === 1 ? "" : "s"} had no client_id, so re-running adds ${withoutId === 1 ? "it" : "them"} again.` : "",
  ].filter(Boolean).join(" ");
}
