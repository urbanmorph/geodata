#!/usr/bin/env node
// collect MCP — author-side tools over the collect REST API. Design a map form,
// review contributions, edit settings, publish to the bharatlas atlas. This is
// NOT a bulk-contribution surface: field contributors are the source of truth;
// an agent flooding synthetic records poisons attribution. Bulk-from-real-data
// is `import_records`, and imported rows carry their attested source honestly.
//
// Auth: create_collection uses an API key (the programmatic-abuse gate) from
// COLLECT_API_KEY; it stores the returned admin token in a local credential
// file (COLLECT_MCP_STORE or ~/.collect-mcp.json), so later moderate/publish/
// edit calls find the admin token by collection id — the plaintext admin link is
// never re-supplied. Mirrors mdshare.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API = process.env.COLLECT_API || 'https://collect.bharatlas.com/api/collect/v1';
const API_KEY = process.env.COLLECT_API_KEY || '';
const STORE = process.env.COLLECT_MCP_STORE || join(homedir(), '.collect-mcp.json');

const INSTRUCTIONS = `collect MCP — author-side tools for collect.bharatlas.com, the crowd map-capture tool in the bharatlas suite. Design a small map form, share a link, moderate what contributors add, and publish to the bharatlas open atlas.

Workflow:
- create_collection to design a map: name, purpose, the geometry it accepts (point/line/polygon), and the fields contributors fill in (validated against the public meta-schema at collect.bharatlas.com/schema/v1.json). Returns share links; the admin token is stored locally so you can manage the map later without re-supplying it.
- Share the returned collect link so people add points in the field. The MCP is not for adding records yourself — human contributors are the source.
- list_records to review; moderate_record to approve/reject each pending point.
- edit_collection to fix the name / description / category / data year / map background after creation.
- import_records for bulk-from-existing-data (e.g. a CSV you already hold) — you MUST pass a source and confirm you have the right to publish it under the map's licence.
- publish to bake approved points into a bharatlas catalogue submission. Then it is discoverable via the read-only bharatlas MCP (list_submissions, query_layer, locate).

Notes:
- No accounts. The link is the credential; the local store keeps admin tokens by collection id.
- Licences must be open (CC0 / CC-BY / CC-BY-SA / ODbL / PDDL / GODL-India / CDLA).
- Attribution is composed at publish from contributors + imported sources — you don't set it.`;

// ---- local credential store -------------------------------------------------
function loadStore() {
  try { return existsSync(STORE) ? JSON.parse(readFileSync(STORE, 'utf8')) : { collections: {} }; }
  catch { return { collections: {} }; }
}
function saveStore(s) { try { writeFileSync(STORE, JSON.stringify(s, null, 2)); } catch { /* best effort */ } }
function rememberCollection(id, name, links) {
  const s = loadStore();
  s.collections[id] = { name, ...links, at: new Date().toISOString() };
  saveStore(s);
}
function adminToken(id) {
  const c = loadStore().collections[id];
  if (!c) throw new Error(`no stored admin token for collection ${id}. It must have been created through this MCP.`);
  // the admin link ends with #adm_...
  const link = c.admin || '';
  const i = link.indexOf('#');
  const tok = i >= 0 ? link.slice(i + 1) : (c.admin_token || '');
  if (!tok) throw new Error(`stored entry for ${id} has no admin token`);
  return tok;
}

// ---- API --------------------------------------------------------------------
async function api(method, path, { token, apiKey, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const ok = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

// ---- tools ------------------------------------------------------------------
const FIELD = {
  type: 'object',
  required: ['key', 'label', 'type'],
  properties: {
    key: { type: 'string', description: 'lowercase identifier: ^[a-z][a-z0-9_]*$' },
    label: { type: 'string' },
    type: { enum: ['text', 'paragraph', 'number', 'select', 'multiselect', 'date', 'url'] },
    required: { type: 'boolean' },
    hint: { type: 'string' },
    options: { type: 'array', items: { type: 'string' }, description: 'required for select/multiselect' },
    min: { type: 'number' }, max: { type: 'number' }, integer: { type: 'boolean' }, maxLength: { type: 'number' },
  },
};

const TOOLS = [
  {
    name: 'create_collection',
    description: 'Design a new map (needs COLLECT_API_KEY). Returns share links; stores the admin token locally so you can manage it later.',
    inputSchema: {
      type: 'object',
      required: ['name', 'purpose', 'geometry', 'fields'],
      properties: {
        name: { type: 'string', description: '3-120 chars' },
        purpose: { type: 'string', description: 'shown to contributors' },
        description: { type: 'string' },
        geometry: { type: 'array', items: { enum: ['point', 'line', 'polygon'] }, description: 'what contributors may add' },
        fields: { type: 'array', items: FIELD, description: 'the form for each record' },
        license: { type: 'string', description: 'open licence id; default CC-BY-4.0' },
        category: { enum: ['boundaries', 'city-wards', 'people', 'environment', 'water', 'agriculture', 'transport', 'infrastructure', 'culture', 'health-edu', 'other'] },
        data_year: { type: 'integer' },
        moderation: { type: 'boolean', description: 'default true — new points wait for approval' },
        basemap: { enum: ['positron', 'satellite', 'topo'] },
      },
    },
  },
  { name: 'list_my_collections', description: 'List maps created through this MCP (from the local store).', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_collection', description: 'Get a map\'s metadata + counts (admin).', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  {
    name: 'edit_collection',
    description: 'Edit a map\'s settings (name/description/purpose/category/data_year/basemap). Licence only while it has no records.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, purpose: { type: 'string' }, category: { type: 'string' }, data_year: { type: ['integer', 'null'] }, basemap: { type: 'string' }, license: { type: 'string' } } },
  },
  { name: 'list_records', description: 'List a map\'s records as a GeoJSON FeatureCollection. status: pending|published|rejected (admin sees all).', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, status: { type: 'string' } } } },
  { name: 'moderate_record', description: 'Approve or reject one pending record (pass the map id it belongs to).', inputSchema: { type: 'object', required: ['id', 'record_id', 'status'], properties: { id: { type: 'string', description: 'the map (collection) id' }, record_id: { type: 'string' }, status: { enum: ['published', 'rejected', 'pending'] }, reason: { type: 'string' } } } },
  {
    name: 'import_records',
    description: 'Bulk-import records you already hold (not synthetic). Requires a named source + rights confirmation; each row lands with that source as provenance.',
    inputSchema: { type: 'object', required: ['id', 'records', 'source', 'rights_confirmed'], properties: { id: { type: 'string' }, records: { type: 'array', items: { type: 'object' }, description: 'GeoJSON-like {geometry, properties}' }, source: { type: 'string' }, rights_confirmed: { type: 'boolean', description: 'you have the right to publish this under the map licence' } } },
  },
  { name: 'publish', description: 'Bake approved records into a bharatlas catalog submission.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
];

async function dispatch(name, a) {
  switch (name) {
    case 'create_collection': {
      if (!API_KEY) return fail('COLLECT_API_KEY is not set — programmatic collection creation needs an API key.');
      const schema_doc = { version: 1, geometry: a.geometry, fields: a.fields };
      if (a.category) schema_doc.category = a.category;
      if (a.basemap) schema_doc.basemap = a.basemap;
      const body = { name: a.name, purpose: a.purpose, description: a.description, license: a.license || 'CC-BY-4.0', data_year: a.data_year, moderation: a.moderation === false ? 0 : 1, schema_doc };
      const r = await api('POST', '/collections', { apiKey: API_KEY, body });
      rememberCollection(r.id, a.name, r.links);
      return ok({ id: r.id, links: r.links, note: 'Share links.edit for contributors. Admin token stored locally.' });
    }
    case 'list_my_collections':
      return ok(Object.entries(loadStore().collections).map(([id, c]) => ({ id, name: c.name, at: c.at })));
    case 'get_collection':
      return ok(await api('GET', `/collections/${a.id}`, { token: adminToken(a.id) }));
    case 'edit_collection': {
      const { id, ...patch } = a;
      return ok(await api('PATCH', `/collections/${id}`, { token: adminToken(id), body: patch }));
    }
    case 'list_records': {
      const qs = a.status ? `?status=${encodeURIComponent(a.status)}` : '';
      return ok(await api('GET', `/collections/${a.id}/records${qs}`, { token: adminToken(a.id) }));
    }
    case 'moderate_record':
      return ok(await api('POST', `/records/${a.record_id}/moderate`, { token: adminToken(a.id), body: { status: a.status, reason: a.reason } }));
    case 'import_records':
      return ok(await api('POST', `/collections/${a.id}/import`, { token: adminToken(a.id), body: { records: a.records, source: a.source, rights_confirmed: !!a.rights_confirmed } }));
    case 'publish':
      return ok(await api('POST', `/collections/${a.id}/publish`, { token: adminToken(a.id) }));
    default:
      return fail(`unknown tool: ${name}`);
  }
}

// ---- server -----------------------------------------------------------------
const server = new Server({ name: 'collect-mcp', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try { return await dispatch(req.params.name, req.params.arguments || {}); }
  catch (e) { return fail(e.message); }
});

await server.connect(new StdioServerTransport());
