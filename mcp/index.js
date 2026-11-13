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
import { INSTRUCTIONS_CORE, READ_TOOLS, readToolRequest, shapeReadResult, toSearchParams } from "./read-tools.js";

const API = process.env.BHARATLAS_API || "https://bharatlas.com/api/v1";

// collect (write side): authoring over the collect REST API. The read tools
// need no auth; the collect tools act only on maps whose share link the user
// has registered (register_map) — the link's token scope IS the permission, so
// this server can never touch a map the user does not hold a link to.
const COLLECT_API = process.env.COLLECT_API || "https://collect.bharatlas.com/api/collect/v1";
const COLLECT_API_KEY = process.env.COLLECT_API_KEY || ""; // optional: only for headless create_map
const COLLECT_STORE = process.env.COLLECT_MCP_STORE || join(homedir(), ".bharatlas-mcp.json");

const SERVER_INSTRUCTIONS = `bharatlas MCP server. India's open geo data: curated layers (state to village boundaries, city wards, forests, hospitals, highways, rivers, canals, groundwater, agro-climatic zones, floods, seismic zones) plus community submissions. It also drives collect.bharatlas.com for authoring your own maps (see "Collect" below).

${INSTRUCTIONS_CORE}

Collect (author your own map): this server also drives collect.bharatlas.com, the crowd map-capture tool in the bharatlas suite.
- Create maps ONLINE at collect.bharatlas.com — the browser handles the anti-abuse check, so no account and no API key are needed. Point the user there to make one. They get three share links, each with a token in the URL #fragment: admin (full control), collect (add points), view (read published points).
- register_map: paste any collect share link to manage that map here. The link's scope decides what you can do:
  - view link  -> get_map, get_records: read / query / export that map's published points (analyse or back up what has been collected).
  - collect link -> the above; field capture itself is done in the browser on a phone via the collect link.
  - admin link -> everything: edit_map (settings), moderate_record (approve/reject), import_points (bulk data you already hold, with a source + rights), and publish.
- publish submits a collect map's approved points to the bharatlas catalog FOR REVIEW — nothing is auto-approved. A bharatlas maintainer approves the submission before it goes live; the response's status is "pending" until then. Once approved it is queryable through the read tools above (list_submissions, query_layer, locate).
- No accounts: the link is the credential. A tool that needs more than your link allows will say which link you need. create_map is optional and needs COLLECT_API_KEY (request-only); prefer creating online.`;

// The eight read tools live in read-tools.js (shared with bharatlas.com/mcp);
// the collect tools need the local credential store, so they are npm-only.
const TOOLS = [
  ...READ_TOOLS,
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
      "view and collect scope return published points; admin can also read pending/rejected via status. " +
      "Each record's properties._photos lists its photo links (public once the point is approved); _ai holds notes a model wrote from the photo (others see only notes the owner accepted).",
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
      "Submit a collect map's approved points to the bharatlas catalog for review (needs the admin link). " +
      "Nothing goes live automatically — a maintainer approves the submission first; the response status is 'pending' until then. " +
      "Once approved it is queryable via list_submissions / query_layer / locate above.",
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
        fields: { type: "array", items: { type: "object" }, description: "the form for each record (see collect.bharatlas.com/schema/v1.json); a field of type \"photo\" (max_photos 1-3) asks for photos" },
        mode: { enum: ["form", "form_ai", "photos_ai"], description: "how people collect: form (default); form_ai = form plus notes a model writes from the photo, for the owner to check; photos_ai = people only take photos and the model fills the form (places only). AI modes need a photo field." },
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
  const qs = toSearchParams(params).toString();
  return httpGet(`${API}${path}${qs ? `?${qs}` : ""}`);
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
    // --- read tools (read-tools.js) ---
    case "list_layers": case "get_layer_schema": case "query_layer": case "nearby":
    case "locate": case "list_categories": case "get_layer_detail": case "list_submissions": {
      const req = readToolRequest(name, args);
      return shapeReadResult(name, await callApi(req.path, req.params));
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
      if (args.mode && args.mode !== "form") schema_doc.mode = args.mode;
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
  { name: "bharatlas-mcp", version: "1.4.0" },
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
