// The bharatlas read tools, shared by the npm stdio server (index.js) and the
// hosted server at https://bharatlas.com/mcp (web/functions/lib/mcp.ts), so the
// two never drift. Plain ESM with no Node or Workers APIs: each tool call maps to
// a GET on the bharatlas API (/api/v1) and its result is shaped the same way.

/** How an agent should use the read tools; each server adds its own intro. */
const CORE = `Workflow patterns:

- **Discovery**: start with list_layers or list_categories to find relevant layers. Use the q parameter for text search.
- **Schema first**: always call get_layer_schema BEFORE query_layer. Column names vary per layer (e.g. "state" vs "State_LGD" vs "stname"). The schema shows exact names and values (every value of a column with at most 20, and how many distinct values each has).
- **Filtering**: query_layer where is an exact, case-insensitive match (no partial or substring match). Pass column=value pairs; check the schema for the right column name and value format. Columns the schema marks as type "nested" (structs, lists, maps, e.g. Overture names/addresses) can be selected but not used in where or group_by (the API returns 400 listing the flat columns).
- **Counting**: use group_by to count features by any column. Example: group_by "category" on the gs_wildlife layer returns national parks vs sanctuaries.
- **Totals**: add sum (numeric columns) to group_by to total values per group, e.g. group_by "district" + sum ["area_ha"] rolls block-level areas up to districts. Percentages are not additive: sum the underlying amounts and recompute shares.
- **Location queries**: locate returns all admin boundaries + zones at a lat/lng, and (for the 30+ cities with ward layers) auto-includes the municipal ward layer that contains the point, so "what ward is this?" works with lat/lng alone. Use it to answer "what state/district/ward is this point in?"
- **Spatial joins** (multi-step): to answer "which X are in Y?" when layers don't share a common column:
  1. Use locate to find the admin context (state, district) of the target area
  2. Use query_layer with a where filter to narrow the other layer by that admin context
  3. For precise spatial containment, test individual points via locate against the target layer
- **Near a point**: nearby returns a layer's features nearest first within radius_km (default 25, max 200), with the true count inside the radius. Use it for "X near Y" once you have Y's coordinate.
- **Community layers**: list_submissions returns user-contributed datasets. These work with query_layer and get_layer_schema exactly like curated layers.
- **Downloads**: get_layer_detail returns direct URLs for the formats a layer has (parquet and pmtiles always; geojson, kml and shapefile for most).
- **Citing**: get_layer_detail also returns "versions", the layer's dated releases, newest first. When you cite or publish a result, name the version you used by its code (e.g. bharatlas-lgd_states-2026.12) and sha256, or its w3id address. An empty list means no release yet: cite the layer's /view page and the date you read it.
- **Large layers**: overture_places_india has 4.8M places. Always narrow it: where on basic_category (e.g. "hospital", "restaurant") or name, group_by, or nearby for places around a point. Whole-table filters and group_by take several seconds; nearby is the fast path for "near me".
- **Honor the terms**: every layer and community submission carries its own source and open licence. When you use, quote, or publish results from a layer, credit its source and respect that licence; get_layer_detail returns the attribution and licence, and each /view page's Dataset JSON-LD carries a creditText to reproduce. A layer whose answer has "non_commercial": true is for non-commercial use only: say so whenever you use or recommend it, quote its "licence_notice", and never suggest it for a product, a client or paid work.

Source preference (multiple layers often cover the same level):
- **Admin boundaries** (state, district, subdistrict, block, village): prefer LGD (lgd_*) as the authoritative source. SOI, Bhuvan, and geoBoundaries are cross-reference alternates with slightly different counts/boundaries. Mention alternates if the user asks about discrepancies.
- **City wards**: each city has its own layer (wards_chennai, wards_pune, etc.). Some cities have multiple vintages (e.g. Bengaluru has GBA 2025 + BBMP 2022 historical).
- **Environment/infrastructure/health**: usually one source per layer. Check the source field.
- **Places near a point**: a kind of place with its own layer is faster and more complete there than in Overture: hospitals and health centres (nic_health: PHCs, CHCs, sub-centres, district hospitals; nhp_hospitals: the national hospital directory), schools (udise_schools), railway stations (ir_stations), metro stations (urban_rail_stations), bus stops (bus_stops), airports (airports), police stations (police_stations_<state>, e.g. police_stations_delhi; list_layers q "police"). Use overture_places_india for other kinds of place (shops, restaurants, banks, hotels, places of worship) or when the user wants business names and addresses.
- **Community submissions**: ALWAYS check list_submissions alongside list_layers when searching. Community layers may cover areas or topics that curated layers don't. They work with query_layer and get_layer_schema identically.
- When multiple sources exist, tell the user which one you're using and why. If results seem wrong, try the alternate source.

Cross-layer queries (combining data from different layers):
- Questions often span multiple layers and categories. "Which wards are near an international airport?" needs the airports layer (transport) + a city ward layer (city-wards).
- **Step 1**: identify all relevant layers using list_layers with different q/category filters.
- **Step 2**: query one layer to get a geographic anchor (e.g. airport location → state/district).
- **Step 3**: use that anchor to find the right layer in the other category (e.g. wards_bengaluru_gba for Karnataka airports).
- **Step 4**: use locate or column filters to find overlapping features.
- Never assume one layer is enough. Think about what layers need to be combined to answer the question fully.
- Use locate as the bridge: find what's at a point across ALL relevant layers in one call by passing multiple layer IDs.
- **Map user concepts to multiple layers.** Users say "water bodies" not "wris_rivers." Translate:
  - "water bodies/water" → wris_rivers, wris_reservoirs, bp_wetlands, bp_ramsar, wris_basin, wris_subbasin, wris_canals
  - "groundwater/aquifer/water table" → cgwb_aquifers, cgwb_gw_extraction, mi6_wells_districts
  - "wells/borewells/tubewells/irrigation pumps" → mi6_wells_districts (census counts per district, 2017-18)
  - "forests/green cover/ecology" → soi_forests, gs_wildlife, bm_eco_zones, biogeographic_zones
  - "agriculture/farming/cropping zones" → agro_ecological_zones, agro_climatic_zones, corestack_lulc_blocks (land use and cropping intensity by block, modelled)
  - "places/POIs/shops/restaurants/ATMs/schools/hospitals by name" → overture_places_india (filter on name or basic_category; 4.8M rows, always add a where or group_by, or use nearby)
  - "hazards/risks" → seismic_zones, india_flood_inventory
  - "health/medical" → nic_health
  - "boundaries/admin" → lgd_states, lgd_districts, lgd_subdistricts, lgd_blocks, lgd_villages
  - "roads/transport" → gs_highways, pmgsy_roads (rural roads), airports
  - "railway stations/metro/bus stops/transit" → ir_stations, urban_rail_stations, urban_rail_lines, bus_stops
  When unsure, use list_layers with a broad q search and list_categories to discover what's available. Combine ALL relevant layers, not just the first match.
- **Sky and air over a place**: once you have a coordinate (from locate, nearby or a layer row), the mugilu MCP (mugilu.live/mcp, tool conditions_at) gives the live air quality, heat, fog and warnings there. bharatlas answers where; mugilu answers what the sky is doing.

Column naming conventions (vary by source):
- State: State_LGD (number), STNAME, stname, state, state_name
- District: Dist_LGD (number), DTNAME, dtname, district, dtcode11
- Block: Block_LGD, BNAME, block_name, blkcode11
- Names are often UPPERCASE in LGD layers, mixed case in other sources`;

/** The lookup tools' advice on sections and layers. */
const NARROW = (tool, examples) =>
  `For a narrow question pass sections (or layers) so ${tool} reads only those: one section takes about 0.1 to 0.3 s, against up to 3 s for everything, and the answer is only what was asked (${examples}). ` +
  "For a broad one ('what is at this point?', a site screening) pass neither and it reads everything. " +
  "list_layers and get_layer_detail say which section reads a layer (lookups); an unknown section, or a layer the tool does not read, is an error naming the valid ones.";

/** The sections and layers arguments of a lookup tool. */
const lookupFilterArgs = (sections, layerExamples) => ({
  sections: {
    type: "array", items: { type: "string", enum: sections },
    description: "Read only these sections (an array, or one comma-separated string); default all",
  },
  layers: {
    type: "array", items: { type: "string" },
    description: `Read only these layers (ids, e.g. ${layerExamples}), as well as any sections asked; default all`,
  },
});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const READ_TOOLS = [
  {
    name: "list_layers",
    description:
      "List available geo layers. Use to discover what data bharatlas has. " +
      "Returns layer IDs, names, row counts, categories, realm (below, ground or air) and, for the layers the point lookups read, " +
      "`lookups` ({ground: section, surface: section}: the section of ground_at or surface_at that reads the layer). " +
      "Filter by category (boundaries, city-wards, environment, water, agriculture, transport, etc.), " +
      "realm, admin level (state, district, block, village, etc.), source, or text search.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category: boundaries, city-wards, people, environment, water, agriculture, transport, infrastructure, health-edu, economy",
        },
        level: {
          type: "string",
          description: "Filter by admin level: state, district, subdistrict, block, village, etc.",
        },
        source: {
          type: "string",
          description: "Filter by data source: LGD, SOI, Bhuvan, OpenCity, DataMeet, etc.",
        },
        realm: {
          type: "string",
          enum: ["below", "ground", "air"],
          description: "Filter by realm: below (rocks, faults, minerals, aquifers, groundwater), ground (boundaries, wards, rivers, forests, roads, places), air (cyclone tracks)",
        },
        q: {
          type: "string",
          description: "Text search across layer IDs, sources, and descriptions",
        },
        limit: { type: "number", description: "Max results (default 20)" },
        offset: { type: "number", description: "Skip N results for pagination" },
      },
    },
  },
  {
    name: "get_layer_schema",
    description:
      "Get column names, types, and values for a layer (all of them for a column with at most 20; distinct_count; up to 50 values with row counts). " +
      "Use BEFORE querying to discover what columns exist and what values they contain. " +
      "Essential for knowing the right column names for filters.",
    inputSchema: {
      type: "object",
      properties: {
        layer_id: {
          type: "string",
          description: "Layer ID (e.g. lgd_states, airports, soi_forests, wards_chennai)",
        },
      },
      required: ["layer_id"],
    },
  },
  {
    name: "query_layer",
    description:
      "Query a layer's data with filters and grouping. Reads the parquet file at runtime. " +
      "Supports: select specific columns, filter by column values, group by a column to get counts, " +
      "and sum numeric columns per group (e.g. roll block areas up to district totals). " +
      "Use get_layer_schema first to discover column names. " +
      "Examples: 'airports in Karnataka' -> where: {state: 'Karnataka'}, " +
      "'forest types' -> group_by: 'type', " +
      "'health facilities in Bihar' -> where: {state: 'BIHAR'}, select: ['name', 'type'].",
    inputSchema: {
      type: "object",
      properties: {
        layer_id: {
          type: "string",
          description: "Layer ID to query",
        },
        select: {
          type: "array",
          items: { type: "string" },
          description: "Column names to return. Omit for all non-geometry columns.",
        },
        where: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Filter conditions as {column: value} pairs. Exact, case-insensitive match on flat columns (not partial). Values may contain commas.",
        },
        group_by: {
          type: "string",
          description: "Column to group by. Returns {value: count} instead of rows.",
        },
        sum: {
          type: "array",
          items: { type: "string" },
          description: "Numeric columns to total per group (requires group_by). Adds {sums: {group: {col: total}}}. Use this to roll finer units up, e.g. block-level areas to district totals. Shares/percentages are not additive: sum the area columns and recompute shares.",
        },
        limit: { type: "number", description: "Max rows (default 100, max 1000)" },
        include_centroid: {
          type: "boolean",
          description: "Include _lat/_lng centroid coordinates (defaults to true). Set false to exclude.",
        },
      },
      required: ["layer_id"],
    },
  },
  {
    name: "locate",
    description:
      "Given a latitude/longitude, find which administrative boundaries, zones, and regions " +
      "contain that point. Returns state, district, subdistrict, block, parliament/assembly " +
      "constituency, pincode, seismic zone, high court jurisdiction, the municipal ward (for " +
      "the 30+ cities with ward layers), and more. " +
      "The 'where am I?' tool. Also accepts specific layer IDs to check.",
    inputSchema: {
      type: "object",
      properties: {
        lat: {
          type: "number",
          description: "Latitude (6 to 38, India bounding box)",
        },
        lng: {
          type: "number",
          description: "Longitude (68 to 98, India bounding box)",
        },
        layers: {
          type: "array",
          items: { type: "string" },
          description: "Specific layer IDs to check. Omit to use the default: 13 essential admin/zone layers PLUS the city ward layer(s) covering the point (for the 30+ cities with ward layers). Passing this replaces the default entirely (no ward auto-include).",
        },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "nearby",
    description:
      "Find features from a layer that are near a given point, nearest first, within radius_km. " +
      "Works for points, polygons and lines: points are measured to the point, lines and polygons to the nearest part of " +
      "their shape (0 inside a polygon; `_distance_to` says which). Returns the true count within the radius plus the nearest `limit`. " +
      "Example: 'reservoirs near Bengaluru' -> layer_id: 'wris_reservoirs', lat: 12.97, lng: 77.59, radius_km: 50.",
    inputSchema: {
      type: "object",
      properties: {
        layer_id: {
          type: "string",
          description: "Layer to search for nearby features",
        },
        lat: { type: "number", description: "Center point latitude" },
        lng: { type: "number", description: "Center point longitude" },
        radius_km: {
          type: "number",
          description: "Search radius in kilometres (default 25, max 200)",
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["layer_id", "lat", "lng"],
    },
  },
  {
    name: "ground_at",
    description:
      "What is below a point, in one call: seismic zone, nearest active faults, lineaments and recorded earthquakes, " +
      "rock type (GSI lithology) and landform, aquifer, a permeability class (GLHYMPS, global and coarse), " +
      "nearby groundwater wells, soil at 0-5, 5-15 and 15-30 cm (ISRIC SoilGrids 2.0: clay, sand, silt, pH, organic carbon, " +
      "bulk density, CEC, nitrogen, WRB soil group) and the nearest Soil Health Card sample, ground subsidence (cm/yr) in megacities, " +
      "and tunnels, buried pipelines and cables, mines and caves nearby. Returns a one-line `summary` plus `sections`, " +
      "each layer with its credit, licence (non-commercial ones flagged) and status (found, none_within_radius, or not_covered where the layer does not reach the point); layers that could not be read are listed in `unavailable`. " +
      "Example: 'what is under this plot in Delhi?' -> lat: 28.525, lng: 77.085. " +
      NARROW("ground_at", "'what seismic zone is this?' -> sections: [\"seismic\"]; 'is the groundwater safe here?' -> sections: [\"groundwater\"]; 'soil at this farm' -> sections: [\"soil\"]"),
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude (6 to 38, India bounding box)" },
        lng: { type: "number", description: "Longitude (68 to 98, India bounding box)" },
        open_only: { type: "boolean", description: "true leaves out the non-commercial layers (for commercial use); default false" },
        ...lookupFilterArgs(["seismic", "geology", "resources", "groundwater", "soil", "subsidence", "underground", "watershed"], "soilgrids (the SoilGrids raster), seismic_zones, cgwb_aquifers"),
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "surface_at",
    description:
      "What is on the ground at a point, in one call: the admin units, ward and pincode; land cover, elevation and slope, " +
      "population density and block land use; climate zones; the river basin, nearest river, water body, dam and wetland, and flood history; " +
      "hazards (seismic zone, landslides, cyclone tracks, coastal regulation zone); forests and protected areas with the nearest one; " +
      "the nearest highway, railway and metro station, airport (one with an IATA code) and bus stop; the nearest hospital (three sources) and school, and places within 1 km; " +
      "the nearest power line, power plant and water-supply facility; distance to India's outline. Returns a one-line `summary` and `sections`, " +
      "each with its credit, licence, scale, vintage and status; for the air above the point, `air` points to the mugilu MCP's conditions_at. " +
      "A point in no state and 5 km or more from India's outline: the summary opens with \"This point is outside India\" (on land) or \"At sea\". " +
      "Example: 'what is around this plot in Kolkata?' -> lat: 22.57, lng: 88.36. " +
      NARROW("surface_at", "'which ward is this?' -> sections: [\"place\"]; 'nearest railway station' -> layers: [\"ir_stations\"]; 'how high is it?' -> layers: [\"dem\"]"),
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude (6 to 38, India bounding box)" },
        lng: { type: "number", description: "Longitude (68 to 98, India bounding box)" },
        open_only: { type: "boolean", description: "true leaves out the non-commercial layers (for commercial use); default false" },
        ...lookupFilterArgs(["place", "land", "climate", "water", "hazards", "protected", "access", "services", "infrastructure"], "dem, worldcover and worldpop (the rasters), ir_stations, gs_highways, or a ward layer such as wards_chennai"),
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "list_categories",
    description: "List all data categories with layer counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_layer_detail",
    description:
      "Get full metadata for a single layer: download URLs (parquet, pmtiles, geojson, kml, shapefile), " +
      "attribution, license, feature count, level metadata, realm (below, ground or air), `lookups` (the section of ground_at or surface_at that reads it, if any), " +
      "and versions (the dated releases to cite).",
    inputSchema: {
      type: "object",
      properties: {
        layer_id: {
          type: "string",
          description: "Layer ID",
        },
      },
      required: ["layer_id"],
    },
  },
  {
    name: "list_submissions",
    description:
      "List community-submitted geo layers. These are user-contributed datasets " +
      "under open licenses. Filter by category or search by name.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search name and description" },
        category: { type: "string", description: "Filter by category" },
        sort: {
          type: "string",
          enum: ["recent", "useful"],
          description: "Sort order (default: recent)",
        },
        limit: { type: "number", description: "Max results (default 20)" },
        offset: { type: "number", description: "Pagination offset" },
      },
    },
  },
].map((t) => ({ ...t, annotations: READ_ONLY }));

const READ_NAMES = new Set(READ_TOOLS.map((t) => t.name));

/** Is `name` one of the read tools (offered or not)? */
export function isReadTool(name) {
  return READ_NAMES.has(name);
}

/** The point lookups: built, but offered only while they are published (the API's POINT_PROFILES flag). */
export const POINT_PROFILE_TOOLS = new Set(["ground_at", "surface_at"]);

/** The read tools a server offers: without the point lookups unless they are on. */
export function readToolsFor(pointProfiles) {
  return pointProfiles ? READ_TOOLS : READ_TOOLS.filter((t) => !POINT_PROFILE_TOOLS.has(t.name));
}

const POINT_PROFILE_PATTERN = `- **A point's profile**: ground_at says what is below a lat/lng (seismic zone, faults, rock, aquifer, groundwater, SoilGrids soil, subsidence, tunnels and buried utilities); surface_at what is on the ground there (place, land cover, elevation, population, water, hazards, protected areas, access, services). One call each instead of many locate/nearby calls; each part carries its source, licence, scale and vintage. For a narrow question pass sections (or layers): the seismic zone is sections ["seismic"], the ward sections ["place"], the nearest station layers ["ir_stations"]; list_layers says each layer's lookups (which section reads it). Pass neither for a broad question. Tell "not_covered" (the layer does not reach the point) apart from "none_within_radius" (radius_km 0: the point is in none of an all-India map's areas, e.g. not in a mapped flood area); say nothing about layers in "unavailable". Give a section's year with its values (about.vintage, or "not dated by the source" with about.fetched_at), and its scale: GLHYMPS is global and coarse, SoilGrids a 250 m model. A section with non_commercial: true is for non-commercial use only: say so and quote its licence_notice; open_only: true leaves those sections out. Pass on the disclaimer (screening information, not for site or engineering decisions). For the air above the point, use the mugilu MCP's conditions_at (surface_at's "air" says how).`;

/** How an agent should use the read tools; each server adds its own intro. */
export function instructionsCore(pointProfiles) {
  return pointProfiles ? CORE.replace("\n- **Community layers**", `\n${POINT_PROFILE_PATTERN}\n- **Community layers**`) : CORE;
}

// Mirrors QUERY_OPTIONS in web/functions/lib/query-params.ts (a web test holds
// the two equal): these names are query options, so a where column with one of
// them must go inside where=.
export const QUERY_RESERVED = new Set(["select", "group_by", "sum", "limit", "where", "order_by", "include_centroid", "filter", "format", "estimate"]);

const LAYER_ID = /^[a-zA-Z0-9_-]+$/;
/** A value going into a URL path (e.g. a collect record id): letters, digits, _ and -
 *  only, so a crafted id can't walk to another endpoint (review 2026-11-18). */
export function idSegment(value, name) {
  const v = String(value ?? "");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new Error(`${name} must be an id (letters, digits, _ and -)`);
  return v;
}

function layerPath(id, suffix = "") {
  if (!LAYER_ID.test(String(id ?? ""))) {
    throw new Error("layer_id must be a layer ID such as lgd_states (letters, digits, _ and -)");
  }
  return `/layers/${id}${suffix}`;
}

/** A list argument: an array of strings, or one comma-separated string (models
 *  often send "a,b"). Anything else is refused by name; undefined when absent. */
function listArg(value, name, what) {
  if (value === undefined || value === null || value === "") return undefined;
  const items = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(items) || !items.every((v) => typeof v === "string")) {
    throw new Error(`${name} must be a list of ${what} (an array of strings, or one comma-separated string)`);
  }
  const out = items.map((v) => v.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

const WHERE_SHAPE = 'where must be an object of {column: value} pairs, e.g. {"STNAME": "KERALA"}';
const SCALAR = new Set(["string", "number", "boolean"]);

/** where as [column, value] pairs: an object, or a "col=value, col2=value2"
 *  string. Never a string's characters (that made one filter per character). */
function whereArg(value) {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") {
    const pairs = value.split(",").map((p) => {
      const eq = p.indexOf("=");
      return eq > 0 ? [p.slice(0, eq).trim(), p.slice(eq + 1).trim()] : null;
    });
    if (pairs.some((p) => !p || !p[0])) throw new Error(WHERE_SHAPE);
    return pairs;
  }
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(WHERE_SHAPE);
  const entries = Object.entries(value);
  if (!entries.every(([, v]) => SCALAR.has(typeof v))) throw new Error(WHERE_SHAPE);
  return entries;
}

/** The API GET a read tool makes: { path, params } under /api/v1, or null when
 *  `name` is not a read tool. Throws on a layer_id the API could never accept. */
export function readToolRequest(name, args = {}) {
  if (!isReadTool(name)) return null;
  switch (name) {
    case "list_layers": {
      const { category, level, source, realm, q, limit = 20, offset } = args;
      return { path: "/layers", params: { category, level, source, realm, q, limit, offset } };
    }
    case "get_layer_schema":
      return { path: layerPath(args.layer_id, "/schema"), params: {} };
    case "query_layer": {
      const { layer_id, where, group_by, limit, include_centroid } = args;
      const params = {};
      const select = listArg(args.select, "select", "column names");
      const sum = listArg(args.sum, "sum", "column names");
      if (select) params.select = select.join(",");
      if (group_by) params.group_by = group_by;
      if (sum) params.sum = sum.join(",");
      if (limit) params.limit = limit;
      if (include_centroid !== undefined) params.include_centroid = String(include_centroid);
      // Each filter as its own ?col=val param so values may contain commas (the
      // API splits a where= string on commas). Columns named like a reserved
      // param must still travel inside where=.
      const reservedWhere = [];
      for (const [k, v] of whereArg(where)) {
        if (QUERY_RESERVED.has(k)) reservedWhere.push(`${k}=${v}`);
        else params[k] = v;
      }
      if (reservedWhere.length) params.where = reservedWhere.join(",");
      return { path: layerPath(layer_id, "/query"), params };
    }
    case "nearby": {
      const { layer_id, lat, lng, radius_km = 25, limit = 20 } = args;
      return { path: "/nearby", params: { lat, lng, layer: layer_id, radius_km: Math.min(radius_km, 200), limit } };
    }
    case "locate": {
      const { lat, lng } = args;
      const params = { lat, lng };
      const layers = listArg(args.layers, "layers", "layer IDs");
      if (layers) params.layers = layers.join(",");
      return { path: "/locate", params };
    }
    case "ground_at":
    case "surface_at": {
      const params = { lat: args.lat, lng: args.lng, ...(args.open_only === true ? { open_only: "true" } : {}) };
      const sections = listArg(args.sections, "sections", "section names");
      const layers = listArg(args.layers, "layers", "layer IDs");
      if (sections) params.sections = sections.join(",");
      if (layers) params.layers = layers.join(",");
      return { path: name === "ground_at" ? "/ground" : "/surface", params };
    }
    case "list_categories":
      return { path: "/categories", params: {} };
    case "get_layer_detail":
      return { path: layerPath(args.layer_id), params: {} };
    case "list_submissions": {
      const { q, category, sort, limit = 20, offset } = args;
      return { path: "/submissions", params: { q, category, sort, limit, offset } };
    }
  }
  return null;
}

/** The query string for a request's params, skipping unset values. */
export function toSearchParams(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) sp.set(k, String(v));
  }
  return sp;
}

/** Shape an API answer for the model: list_layers drops the per-layer download
 *  URLs (get_layer_detail has them), which keeps the list compact. */
/** The npm server offers ground_at and surface_at unless BHARATLAS_POINT_PROFILES=off
 *  (the API's own kill switch is POINT_PROFILES=off). */
export function pointProfilesOn(env) {
  return env.BHARATLAS_POINT_PROFILES !== "off";
}

/** A tool answer as the model reads it: compact JSON (indentation only cost tokens),
 *  big integers as numbers. */
export function resultText(value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}

const RETRYABLE = new Set([429, 502, 503]);
/** `send()` (a read), sent once more after a passing 429, 502 or 503. */
export async function withRetry(send, { delayMs = 600 } = {}) {
  const res = await send();
  if (!RETRYABLE.has(res.status)) return res;
  await new Promise((r) => setTimeout(r, delayMs));
  return send();
}

/** The server's own timings: for us (Server-Timing, the speed records), not the model. */
const TIMINGS = ["timing_ms", "layer_timing_ms"];
const withoutTimings = (r) => {
  if (!r || typeof r !== "object" || Array.isArray(r) || !TIMINGS.some((k) => k in r)) return r;
  const out = { ...r };
  for (const k of TIMINGS) delete out[k];
  return out;
};

export function shapeReadResult(name, raw) {
  const result = withoutTimings(raw);
  if (name === "list_layers" && Array.isArray(result?.data)) {
    return {
      ...result,
      data: result.data.map((l) => ({
        id: l.id, level: l.level, source: l.source, category: l.category, realm: l.realm,
        ...(l.lookups ? { lookups: l.lookups } : {}),
        rows: l.rows, licence: l.licence, notes: l.notes,
        ...(l.non_commercial ? { non_commercial: true, licence_notice: l.licence_notice } : {}),
      })),
    };
  }
  return result;
}
