---
name: bharatlas
description: Use this skill for questions about India's geography and administrative data, or to author your own map. Activates when the user asks what state / district / subdistrict / block / village / ward / constituency / pincode / seismic zone / eco zone a place or coordinate is in; wants counts or lists of Indian admin units, forests, wildlife, rivers, reservoirs, dams, hospitals, highways, airports, flood or seismic zones; wants features near a point; wants to download an Indian geo layer (Parquet, PMTiles, GeoJSON, KML, Shapefile); or wants to run a crowd map-capture with collect (design a form, review contributions, publish to the bharatlas catalog). Triggers on phrases like "which district is this", "how many villages in", "wards in Chennai", "reservoirs near", "download the boundaries", "locate this lat lng", or any mention of bharatlas or collect.
version: 1.1.1
license: MIT
---

# bharatlas: India's open geo atlas via MCP

bharatlas (bharatlas.com) is India's open geo data catalog. This skill drives 17 MCP tools: a read side over curated layers plus community submissions, and an authoring side for collect maps.

## When to use

- Any question about Indian administrative geography (state to village), city wards, constituencies, pincodes.
- Environment / infrastructure / hazard data: forests, wildlife, rivers, reservoirs, dams, groundwater, agro zones, hospitals, highways, airports, flood and seismic zones.
- "What is at this coordinate?" or "what is near this point?" in India.
- Downloading a layer in a GIS format.
- Running a field data collection with collect and publishing the result.

## When NOT to use

- Directions, traffic, or finding a business (that is Google Maps, not bharatlas).
- Editing the base map itself (that is OpenStreetMap).
- Geography outside India (bharatlas is India-only).

## Read workflow

1. **Discover**: `list_layers` (filter by category, level, source, or `q` search) and `list_categories`. Always check `list_submissions` too, community layers may cover topics the curated set does not.
2. **Schema first**: call `get_layer_schema` BEFORE `query_layer`. Column names vary by source ("state" vs "State_LGD" vs "stname"); the schema shows exact names and sample values.
3. **Query**: `query_layer` with `where` (case-insensitive column=value), `select`, or `group_by` for counts. Reads the parquet at runtime.
4. **Locate**: `locate` with lat/lng returns every admin boundary and zone containing that point in one call. The "where am I?" tool.
5. **Nearby**: `nearby` finds features of a layer within a radius (points, lines, or polygons).
6. **Download**: `get_layer_detail` returns direct URLs for parquet, pmtiles, geojson, kml, shapefile.

### Source preference

- Admin boundaries (state to village): prefer LGD (`lgd_*`) as authoritative. SOI, Bhuvan, geoBoundaries are cross-reference alternates; mention them if the user asks about discrepancies.
- City wards: one layer per city (`wards_chennai`, `wards_pune`, ...); some cities have multiple vintages.
- Always join on LGD codes, not names (spellings drift across sources).

### Map user concepts to layers

- "water bodies" -> wris_rivers, wris_reservoirs, bp_wetlands, bp_ramsar, wris_basin, wris_canals
- "groundwater / aquifer" -> cgwb_aquifers, cgwb_gw_extraction
- "forests / ecology" -> soi_forests, gs_wildlife, bm_eco_zones, biogeographic_zones
- "agriculture / cropping zones" -> agro_ecological_zones, agro_climatic_zones
- "hazards" -> seismic_zones, india_flood_inventory
- "health" -> nic_health; "roads / transport" -> gs_highways, airports

Combine ALL relevant layers, not just the first match. Use `locate` as the bridge across layers at a point.

## Collect authoring (your own maps)

New maps are created ONLINE at collect.bharatlas.com (the browser handles the anti-abuse check, no account or key). Then bring a map here:

1. `register_map(link)`: paste any collect share link. The token in its `#fragment` sets your scope, `adm_` admin, `edt_` collect, `viw_` view.
2. `list_my_maps`, `get_map` (metadata + counts + a link to open it in collect), `get_records` (published points as GeoJSON, for reading, analysis, or backup).
3. Admin link only: `edit_map` (settings), `moderate_record` (approve/reject a point), `import_points` (bulk data you already hold, with a named source + rights confirmation).
4. `publish`: bakes approved points into a bharatlas **catalog** submission. It is then queryable through the read tools above (`list_submissions`, `query_layer`, `locate`), closing the loop: gather, moderate, publish, query, all here.

The link is the credential; a tool that needs more than your scope will tell you which link to register. `create_map` exists but needs a request-only `COLLECT_API_KEY`; prefer creating online.

## Tool reference

**Read:** list_layers, list_categories, get_layer_schema, query_layer, locate, nearby, get_layer_detail, list_submissions.

**Author:** register_map, list_my_maps, get_map, get_records, moderate_record, import_points, edit_map, publish, create_map.
