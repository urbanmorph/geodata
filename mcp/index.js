#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import https from "node:https";

const API = process.env.BHARATLAS_API || "https://bharatlas.com/api/v1";

const SERVER_INSTRUCTIONS = `bharatlas MCP server. India's open geo data: curated layers (state to village boundaries, city wards, forests, hospitals, highways, floods, seismic zones) plus community submissions.

Workflow patterns:

- **Discovery**: start with list_layers or list_categories to find relevant layers. Use the q parameter for text search.
- **Schema first**: always call get_layer_schema BEFORE query_layer. Column names vary per layer (e.g. "state" vs "State_LGD" vs "stname"). The schema shows exact names and sample values.
- **Filtering**: query_layer where conditions are case-insensitive. Pass column=value pairs. Check the schema for the right column name and value format.
- **Counting**: use group_by to count features by any column. Example: group_by "type" on wildlife layer returns counts per category.
- **Location queries**: locate returns all admin boundaries + zones at a lat/lng. Use it to answer "what state/district/ward is this point in?"
- **Spatial joins** (multi-step): to answer "which X are in Y?" when layers don't share a common column:
  1. Use locate to find the admin context (state, district) of the target area
  2. Use query_layer with a where filter to narrow the other layer by that admin context
  3. For precise spatial containment, test individual points via locate against the target layer
- **Community layers**: list_submissions returns user-contributed datasets. These work with query_layer and get_layer_schema exactly like curated layers.
- **Downloads**: get_layer_detail returns direct URLs for parquet, pmtiles, geojson, kml, and shapefile formats.

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
  - "water bodies/water" → wris_rivers, wris_reservoirs, bp_wetlands, bp_ramsar, wris_basin, wris_subbasin
  - "forests/green cover" → soi_forests, gs_wildlife, bm_eco_zones
  - "hazards/risks" → seismic_zones, india_flood_inventory
  - "health/medical" → nic_health
  - "boundaries/admin" → lgd_states, lgd_districts, lgd_subdistricts, lgd_blocks, lgd_villages
  - "roads/transport" → gs_highways, airports
  When unsure, use list_layers with a broad q search and list_categories to discover what's available. Combine ALL relevant layers, not just the first match.

Column naming conventions (vary by source):
- State: State_LGD (number), STNAME, stname, state, state_name
- District: Dist_LGD (number), DTNAME, dtname, district, dtcode11
- Block: Block_LGD, BNAME, block_name, blkcode11
- Names are often UPPERCASE in LGD layers, mixed case in other sources`;

const TOOLS = [
  {
    name: "list_layers",
    description:
      "List available geo layers. Use to discover what data bharatlas has. " +
      "Returns layer IDs, names, row counts, categories, and download formats. " +
      "Filter by category (boundaries, city-wards, environment, transport, etc.), " +
      "admin level (state, district, block, village, etc.), source, or text search.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Filter by category: boundaries, city-wards, people, environment, transport, infrastructure, health-edu",
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
      "Supports: select specific columns, filter by column values, group by a column to get counts. " +
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
          description: "Filter conditions as {column: value} pairs. Case-insensitive matching.",
        },
        group_by: {
          type: "string",
          description: "Column to group by. Returns {value: count} instead of rows.",
        },
        limit: { type: "number", description: "Max rows (default 100, max 1000)" },
        include_centroid: {
          type: "boolean",
          description: "Include _lat/_lng centroid coordinates in results (from bbox columns). Use for proximity/distance calculations.",
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
      "constituency, pincode, seismic zone, high court jurisdiction, and more. " +
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
          description: "Specific layer IDs to check (default: 12 essential layers covering all admin levels + zones)",
        },
      },
      required: ["lat", "lng"],
    },
  },
  {
    name: "nearby",
    description:
      "Find features from a layer that are near a given point. Samples a grid of points around the " +
      "center and checks which hit the target layer via locate. Generic: works for any layer type " +
      "(polygons, points, lines) without needing coordinate columns. " +
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
];

const VERSION = "1.0.2";

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { "User-Agent": `bharatlas-mcp/${VERSION}` },
    };
    https.get(options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode >= 400) reject(new Error(`API ${res.statusCode}: ${body.slice(0, 200)}`));
        else resolve(JSON.parse(body));
      });
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function callApi(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return httpGet(url.toString());
}

async function handleTool(name, args) {
  switch (name) {
    case "list_layers": {
      const { category, level, source, q, limit = 20, offset } = args;
      const result = await callApi("/layers", { category, level, source, q, limit, offset });
      // FIX #1: compact response - strip download URLs from list view
      if (result.data) {
        result.data = result.data.map((l) => ({
          id: l.id, level: l.level, source: l.source, category: l.category,
          rows: l.rows, licence: l.licence, notes: l.notes,
        }));
      }
      return result;
    }

    case "get_layer_schema": {
      return callApi(`/layers/${args.layer_id}/schema`);
    }

    case "query_layer": {
      const { layer_id, select, where, group_by, limit, include_centroid } = args;
      const params = {};
      if (select?.length) params.select = select.join(",");
      if (group_by) params.group_by = group_by;
      if (limit) params.limit = limit;
      if (include_centroid) params.include_centroid = "true";
      if (where) params.where = Object.entries(where).map(([k, v]) => `${k}=${v}`).join(",");
      return callApi(`/layers/${layer_id}/query`, params);
    }

    case "nearby": {
      const { layer_id, lat, lng, radius_km = 25, limit = 20 } = args;
      return callApi("/nearby", { lat, lng, layer: layer_id, radius_km: Math.min(radius_km, 200), limit });
    }

    case "locate": {
      const { lat, lng, layers } = args;
      const params = { lat, lng };
      if (layers?.length) params.layers = layers.join(",");
      return callApi("/locate", params);
    }

    case "list_categories": {
      return callApi("/categories");
    }

    case "get_layer_detail": {
      return callApi(`/layers/${args.layer_id}`);
    }

    case "list_submissions": {
      const { q, category, sort, limit = 20, offset } = args;
      return callApi("/submissions", { q, category, sort, limit, offset });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: "bharatlas-mcp", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error.message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
