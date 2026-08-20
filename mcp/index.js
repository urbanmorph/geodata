#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import https from "node:https";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const API = process.env.BHARATLAS_API || "https://bharatlas.com/api/v1";

// collect (write side): authoring over the collect REST API. The read tools
// need no auth; the collect tools act only on maps whose share link the user
// has registered (register_map) — the link's token scope IS the permission, so
// this server can never touch a map the user does not hold a link to.
const COLLECT_API = process.env.COLLECT_API || "https://collect.bharatlas.com/api/collect/v1";
const COLLECT_API_KEY = process.env.COLLECT_API_KEY || ""; // optional: only for headless create_map
const COLLECT_STORE = process.env.COLLECT_MCP_STORE || join(homedir(), ".bharatlas-mcp.json");

const SERVER_INSTRUCTIONS = `bharatlas MCP server. India's open geo data: curated layers (state to village boundaries, city wards, forests, hospitals, highways, rivers, canals, groundwater, agro-climatic zones, floods, seismic zones) plus community submissions. It also drives collect.bharatlas.com for authoring your own maps (see "Collect" below).

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
  - "water bodies/water" → wris_rivers, wris_reservoirs, bp_wetlands, bp_ramsar, wris_basin, wris_subbasin, wris_canals
  - "groundwater/aquifer/water table" → cgwb_aquifers, cgwb_gw_extraction
  - "forests/green cover/ecology" → soi_forests, gs_wildlife, bm_eco_zones, biogeographic_zones
  - "agriculture/farming/cropping zones" → agro_ecological_zones, agro_climatic_zones
  - "hazards/risks" → seismic_zones, india_flood_inventory
  - "health/medical" → nic_health
  - "boundaries/admin" → lgd_states, lgd_districts, lgd_subdistricts, lgd_blocks, lgd_villages
  - "roads/transport" → gs_highways, airports
  When unsure, use list_layers with a broad q search and list_categories to discover what's available. Combine ALL relevant layers, not just the first match.

Column naming conventions (vary by source):
- State: State_LGD (number), STNAME, stname, state, state_name
- District: Dist_LGD (number), DTNAME, dtname, district, dtcode11
- Block: Block_LGD, BNAME, block_name, blkcode11
- Names are often UPPERCASE in LGD layers, mixed case in other sources

Collect (author your own map): this server also drives collect.bharatlas.com, the crowd map-capture tool in the bharatlas suite.
- Create maps ONLINE at collect.bharatlas.com — the browser handles the anti-abuse check, so no account and no API key are needed. Point the user there to make one. They get three share links, each with a token in the URL #fragment: admin (full control), collect (add points), view (read published points).
- register_map: paste any collect share link to manage that map here. The link's scope decides what you can do:
  - view link  -> get_map, get_records: read / query / export that map's published points (analyse or back up what has been collected).
  - collect link -> the above; field capture itself is done in the browser on a phone via the collect link.
  - admin link -> everything: edit_map (settings), moderate_record (approve/reject), import_points (bulk data you already hold, with a source + rights), and publish.
- publish bakes approved points into a bharatlas catalog submission. It is then queryable through the read tools above (list_submissions, query_layer, locate) — the full loop, gather -> moderate -> publish -> query, in one server.
- No accounts: the link is the credential. A tool that needs more than your link allows will say which link you need. create_map is optional and needs COLLECT_API_KEY (request-only); prefer creating online.`;

const TOOLS = [
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

  // --- collect (authoring): act only on maps whose share link you registered ---
  {
    name: "register_map",
    description:
      "Register a collect map so this server can act on it. Paste the whole share link " +
      "(e.g. https://collect.bharatlas.com/c/<id>/admin#<token>). The token in the #fragment sets your scope: " +
      "admin = full control, collect = add points, view = read published. New maps are created online at " +
      "collect.bharatlas.com first (no account or key needed); this registers one you already made.",
    inputSchema: {
      type: "object",
      properties: { link: { type: "string", description: "a collect.bharatlas.com share link with the token in the #fragment" } },
      required: ["link"],
    },
  },
  {
    name: "list_my_maps",
    description: "List the collect maps you have registered here (local store), each with its scope.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_map",
    description: "A collect map's metadata + record counts, plus a link to open it in collect. Any registered scope.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "the map (collection) id" } }, required: ["id"] },
  },
  {
    name: "get_records",
    description:
      "A collect map's records as a GeoJSON FeatureCollection — for reading, analysis, or backup/export. " +
      "view and collect scope return published points; admin can also read pending/rejected via status.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, status: { type: "string", description: "admin only: pending | published | rejected" } },
      required: ["id"],
    },
  },
  {
    name: "moderate_record",
    description: "Approve or reject one pending point (needs the admin link). Pass the map id it belongs to.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "the map (collection) id" },
        record_id: { type: "string" },
        status: { enum: ["published", "rejected", "pending"] },
        reason: { type: "string" },
      },
      required: ["id", "record_id", "status"],
    },
  },
  {
    name: "import_points",
    description:
      "Bulk-import points you already hold into a collect map (needs the admin link). NOT for synthetic data. " +
      "Requires a named source + rights confirmation; each row lands with that source as its provenance.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        records: { type: "array", items: { type: "object" }, description: "GeoJSON-like {geometry, properties}" },
        source: { type: "string" },
        rights_confirmed: { type: "boolean", description: "you have the right to publish this under the map's licence" },
      },
      required: ["id", "records", "source", "rights_confirmed"],
    },
  },
  {
    name: "edit_map",
    description:
      "Edit a collect map's settings: name/description/purpose/category/data_year/basemap (needs the admin link). " +
      "Licence can only change while the map has no records.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, purpose: { type: "string" },
        category: { type: "string" }, data_year: { type: ["integer", "null"] }, basemap: { type: "string" }, license: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "publish",
    description:
      "Bake a collect map's approved points into a bharatlas catalog submission (needs the admin link). " +
      "Once published it is queryable via list_submissions / query_layer / locate above.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_map",
    description:
      "Optional: create a collect map programmatically. Most maps are made online at collect.bharatlas.com (no key needed) — " +
      "prefer that and register_map the link. This path needs COLLECT_API_KEY (the request-only anti-abuse gate) and " +
      "auto-registers the new admin link.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "3-120 chars" },
        purpose: { type: "string", description: "shown to contributors" },
        description: { type: "string" },
        geometry: { type: "array", items: { enum: ["point", "line", "polygon"] }, description: "what contributors may add" },
        fields: { type: "array", items: { type: "object" }, description: "the form for each record (see collect.bharatlas.com/schema/v1.json)" },
        license: { type: "string", description: "open licence id; default CC-BY-4.0" },
        category: { type: "string" },
        data_year: { type: "integer" },
        moderation: { type: "boolean", description: "default true — points wait for approval" },
        basemap: { enum: ["positron", "satellite", "topo"] },
      },
      required: ["name", "purpose", "geometry", "fields"],
    },
  },
];

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
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

// ---- collect: local credential store + scoped auth --------------------------
const SCOPE_BY_PREFIX = { adm: "admin", edt: "edit", viw: "view" };
const SCOPE_RANK = { view: 0, edit: 1, admin: 2 };
const scopeOfToken = (t) => SCOPE_BY_PREFIX[String(t || "").slice(0, 3)] || null;
const atLeastScope = (have, need) => (SCOPE_RANK[have] ?? -1) >= SCOPE_RANK[need];

function loadStore() {
  try { return existsSync(COLLECT_STORE) ? JSON.parse(readFileSync(COLLECT_STORE, "utf8")) : { maps: {} }; }
  catch { return { maps: {} }; }
}
function saveStore(s) { try { writeFileSync(COLLECT_STORE, JSON.stringify(s, null, 2)); } catch { /* best effort */ } }
function rememberMap(id, entry) { const s = loadStore(); s.maps[id] = { ...s.maps[id], ...entry }; saveStore(s); }
function mapEntry(id) {
  const m = loadStore().maps[id];
  if (!m) throw new Error(`map ${id} is not registered. Create it online at collect.bharatlas.com, then register_map with its share link.`);
  return m;
}
function tokenFor(id, need) {
  const m = mapEntry(id);
  if (need && !atLeastScope(m.scope, need)) {
    throw new Error(`this needs the ${need} link for map ${id}; you registered the ${m.scope} link. Register the ${need} link to do this.`);
  }
  return m.token;
}
function parseShareLink(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { throw new Error("not a valid URL — paste the whole collect share link"); }
  const token = (u.hash || "").replace(/^#/, "");
  const scope = scopeOfToken(token);
  if (!scope) throw new Error("no token found in the link #fragment (expected #adm_… / #edt_… / #viw_…)");
  const parts = u.pathname.split("/").filter(Boolean); // ["c", "<id>", "admin"?]
  const ci = parts.indexOf("c");
  const id = ci >= 0 ? parts[ci + 1] : null;
  if (!id) throw new Error("could not find the map id in the link path (expected /c/<id>…)");
  return { id, token, scope, link: u.toString() };
}

// ---- collect: HTTP (GET/POST/PATCH with auth headers) -----------------------
function httpReq(method, urlStr, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const opts = { method, headers: { ...headers } };
    if (data) opts.headers["content-type"] = "application/json";
    const req = https.request(new URL(urlStr), opts, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        let parsed;
        try { parsed = buf ? JSON.parse(buf) : {}; } catch { parsed = { raw: buf }; }
        if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}: ${buf.slice(0, 200)}`));
        else resolve(parsed);
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
function collectApi(method, path, { token, apiKey, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers["x-api-key"] = apiKey;
  return httpReq(method, COLLECT_API + path, { headers, body });
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

    // --- collect (authoring) ---
    case "register_map": {
      const { id, token, scope, link } = parseShareLink(args.link);
      let name;
      try {
        const meta = await collectApi("GET", `/collections/${id}`, { token });
        name = meta.name || meta.data?.name;
      } catch { /* metadata is best-effort; still register */ }
      rememberMap(id, { token, scope, link, name, at: new Date().toISOString() });
      const can = scope === "admin"
        ? "moderate, edit, import and publish"
        : scope === "edit"
          ? "read and export (add points in the browser via the collect link)"
          : "read and export published points";
      return { id, scope, name, note: `Registered the ${scope} link for "${name || id}". You can now ${can}.` };
    }

    case "list_my_maps":
      return Object.entries(loadStore().maps).map(([id, m]) => ({ id, name: m.name, scope: m.scope, at: m.at }));

    case "get_map": {
      const m = mapEntry(args.id);
      const meta = await collectApi("GET", `/collections/${args.id}`, { token: m.token });
      return { ...meta, open_in_collect: m.link };
    }

    case "get_records": {
      const m = mapEntry(args.id);
      const qs = args.status ? `?status=${encodeURIComponent(args.status)}` : "";
      return collectApi("GET", `/collections/${args.id}/records${qs}`, { token: m.token });
    }

    case "moderate_record":
      return collectApi("POST", `/records/${args.record_id}/moderate`, {
        token: tokenFor(args.id, "admin"),
        body: { status: args.status, reason: args.reason },
      });

    case "import_points":
      return collectApi("POST", `/collections/${args.id}/import`, {
        token: tokenFor(args.id, "admin"),
        body: { records: args.records, source: args.source, rights_confirmed: !!args.rights_confirmed },
      });

    case "edit_map": {
      const { id, ...patch } = args;
      return collectApi("PATCH", `/collections/${id}`, { token: tokenFor(id, "admin"), body: patch });
    }

    case "publish":
      return collectApi("POST", `/collections/${args.id}/publish`, { token: tokenFor(args.id, "admin") });

    case "create_map": {
      if (!COLLECT_API_KEY) {
        throw new Error("create_map needs COLLECT_API_KEY (request-only). Most maps are created online at collect.bharatlas.com — do that, then register_map with the share link.");
      }
      const schema_doc = { version: 1, geometry: args.geometry, fields: args.fields };
      if (args.category) schema_doc.category = args.category;
      if (args.basemap) schema_doc.basemap = args.basemap;
      const body = {
        name: args.name, purpose: args.purpose, description: args.description,
        license: args.license || "CC-BY-4.0", data_year: args.data_year,
        moderation: args.moderation === false ? 0 : 1, schema_doc,
      };
      const r = await collectApi("POST", "/collections", { apiKey: COLLECT_API_KEY, body });
      const adminLink = r.links?.admin;
      if (adminLink) {
        try {
          const p = parseShareLink(adminLink);
          rememberMap(p.id, { token: p.token, scope: p.scope, link: p.link, name: args.name, at: new Date().toISOString() });
        } catch { /* ignore */ }
      }
      return { id: r.id, links: r.links, note: "Share links.collect with contributors. Admin link registered locally." };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: "bharatlas-mcp", version: "1.1.1" },
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
