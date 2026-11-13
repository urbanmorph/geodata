// The bharatlas read tools, shared by the npm stdio server (index.js) and the
// hosted server at https://bharatlas.com/mcp (web/functions/lib/mcp.ts), so the
// two never drift. Plain ESM with no Node or Workers APIs: each tool call maps to
// a GET on the bharatlas API (/api/v1) and its result is shaped the same way.

/** How an agent should use the read tools; each server adds its own intro. */
export const INSTRUCTIONS_CORE = `Workflow patterns:

- **Discovery**: start with list_layers or list_categories to find relevant layers. Use the q parameter for text search.
- **Schema first**: always call get_layer_schema BEFORE query_layer. Column names vary per layer (e.g. "state" vs "State_LGD" vs "stname"). The schema shows exact names and sample values.
- **Filtering**: query_layer where is an exact, case-insensitive match (no partial or substring match). Pass column=value pairs; check the schema for the right column name and value format. Columns the schema marks as type "nested" (structs, lists, maps, e.g. Overture names/addresses) can be selected but not used in where or group_by (the API returns 400 listing the flat columns).
- **Counting**: use group_by to count features by any column. Example: group_by "category" on the gs_wildlife layer returns national parks vs sanctuaries.
- **Totals**: add sum (numeric columns) to group_by to total values per group, e.g. group_by "district" + sum ["area_ha"] rolls block-level areas up to districts. Percentages are not additive: sum the underlying amounts and recompute shares.
- **Location queries**: locate returns all admin boundaries + zones at a lat/lng, and (for the ~30 covered cities) auto-includes the municipal ward layer that contains the point — so "what ward is this?" just works with lat/lng alone. Use it to answer "what state/district/ward is this point in?"
- **Spatial joins** (multi-step): to answer "which X are in Y?" when layers don't share a common column:
  1. Use locate to find the admin context (state, district) of the target area
  2. Use query_layer with a where filter to narrow the other layer by that admin context
  3. For precise spatial containment, test individual points via locate against the target layer
- **Community layers**: list_submissions returns user-contributed datasets. These work with query_layer and get_layer_schema exactly like curated layers.
- **Downloads**: get_layer_detail returns direct URLs for the formats a layer has (parquet and pmtiles always; geojson, kml and shapefile for most).
- **Large layers**: overture_places_india has 4.4M places. Always narrow it: where on basic_category (e.g. "hospital", "restaurant") or name, group_by, or nearby for places around a point. Whole-table filters and group_by take several seconds; nearby is the fast path for "near me".
- **Honor the terms**: every layer and community submission carries its own source and open licence. When you use, quote, or publish results from a layer, credit its source and respect that licence; get_layer_detail returns the attribution and licence, and each /view page's Dataset JSON-LD carries a creditText to reproduce.

Source preference (multiple layers often cover the same level):
- **Admin boundaries** (state, district, subdistrict, block, village): prefer LGD (lgd_*) as the authoritative source. SOI, Bhuvan, and geoBoundaries are cross-reference alternates with slightly different counts/boundaries. Mention alternates if the user asks about discrepancies.
- **City wards**: each city has its own layer (wards_chennai, wards_pune, etc.). Some cities have multiple vintages (e.g. Bengaluru has GBA 2025 + BBMP 2022 historical).
- **Environment/infrastructure/health**: usually one source per layer. Check the source field.
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
  - "places/POIs/shops/restaurants/ATMs/schools/hospitals by name" → overture_places_india (filter on name or basic_category; 4.4M rows, always add a where or group_by, or use nearby)
  - "hazards/risks" → seismic_zones, india_flood_inventory
  - "health/medical" → nic_health
  - "boundaries/admin" → lgd_states, lgd_districts, lgd_subdistricts, lgd_blocks, lgd_villages
  - "roads/transport" → gs_highways, airports
  When unsure, use list_layers with a broad q search and list_categories to discover what's available. Combine ALL relevant layers, not just the first match.
- **Sky and air over a place**: once you have a coordinate (from locate, nearby or a layer row), the mugilu MCP (mugilu.live/mcp, tool conditions_at) gives the live air quality, heat, fog and warnings there. bharatlas answers where; mugilu answers what the sky is doing.

Column naming conventions (vary by source):
- State: State_LGD (number), STNAME, stname, state, state_name
- District: Dist_LGD (number), DTNAME, dtname, district, dtcode11
- Block: Block_LGD, BNAME, block_name, blkcode11
- Names are often UPPERCASE in LGD layers, mixed case in other sources`;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const READ_TOOLS = [
  {
    name: "list_layers",
    description:
      "List available geo layers. Use to discover what data bharatlas has. " +
      "Returns layer IDs, names, row counts, categories, and download formats. " +
      "Filter by category (boundaries, city-wards, environment, water, agriculture, transport, etc.), " +
      "admin level (state, district, block, village, etc.), source, or text search.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category: boundaries, city-wards, people, environment, water, agriculture, transport, infrastructure, health-edu",
        },
        level: {
          type: "string",
          description: "Filter by admin level: state, district, subdistrict, block, village, etc.",
        },
        source: {
          type: "string",
          description: "Filter by data source: LGD, SOI, Bhuvan, OpenCity, DataMeet, etc.",
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
      "Get column names, types, and sample values for a layer. " +
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
      "Examples: 'airports in Karnataka' -> where: {state: 'KA'}, " +
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
      "the ~30 cities with ward data), and more. " +
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
          description: "Specific layer IDs to check. Omit to use the default: 12 essential admin/zone layers PLUS the city ward layer(s) covering the point (for the ~30 cities with ward data). Passing this replaces the default entirely (no ward auto-include).",
        },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "nearby",
    description:
      "Find features from a layer that are near a given point, nearest first, within radius_km. " +
      "Reads the layer's parquet bounding boxes and ranks features by distance to their centres; " +
      "works for points, polygons and lines. Returns the true count within the radius plus the nearest `limit`. " +
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
    name: "list_categories",
    description: "List all data categories with layer counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_layer_detail",
    description:
      "Get full metadata for a single layer: download URLs (parquet, pmtiles, geojson, kml, shapefile), " +
      "attribution, license, feature count, and level metadata.",
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

// Mirrors RESERVED in web/functions/lib/query-params.ts: these names are query
// options, so a where column with one of them must go inside where=.
const QUERY_RESERVED = new Set(["select", "group_by", "sum", "limit", "where", "order_by", "include_centroid"]);

const LAYER_ID = /^[a-zA-Z0-9_-]+$/;
function layerPath(id, suffix = "") {
  if (!LAYER_ID.test(String(id ?? ""))) {
    throw new Error("layer_id must be a layer ID such as lgd_states (letters, digits, _ and -)");
  }
  return `/layers/${id}${suffix}`;
}

/** The API GET a read tool makes: { path, params } under /api/v1, or null when
 *  `name` is not a read tool. Throws on a layer_id the API could never accept. */
export function readToolRequest(name, args = {}) {
  if (!READ_NAMES.has(name)) return null;
  switch (name) {
    case "list_layers": {
      const { category, level, source, q, limit = 20, offset } = args;
      return { path: "/layers", params: { category, level, source, q, limit, offset } };
    }
    case "get_layer_schema":
      return { path: layerPath(args.layer_id, "/schema"), params: {} };
    case "query_layer": {
      const { layer_id, select, where, group_by, sum, limit, include_centroid } = args;
      const params = {};
      if (select?.length) params.select = select.join(",");
      if (group_by) params.group_by = group_by;
      if (sum?.length) params.sum = sum.join(",");
      if (limit) params.limit = limit;
      if (include_centroid !== undefined) params.include_centroid = String(include_centroid);
      // Each filter as its own ?col=val param so values may contain commas (the
      // API splits a where= string on commas). Columns named like a reserved
      // param must still travel inside where=.
      const reservedWhere = [];
      for (const [k, v] of Object.entries(where || {})) {
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
      const { lat, lng, layers } = args;
      const params = { lat, lng };
      if (layers?.length) params.layers = layers.join(",");
      return { path: "/locate", params };
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
export function shapeReadResult(name, result) {
  if (name === "list_layers" && Array.isArray(result?.data)) {
    return {
      ...result,
      data: result.data.map((l) => ({
        id: l.id, level: l.level, source: l.source, category: l.category,
        rows: l.rows, licence: l.licence, notes: l.notes,
      })),
    };
  }
  return result;
}
