// Non-commercial layers must say so to the model too (owner, 2026-11-15): the
// API marks them with non_commercial + licence_notice, and the MCP keeps both
// in the compact layer list and tells the model what they mean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeReadResult, instructionsCore, readToolRequest } from "./read-tools.js";

const INSTRUCTIONS_CORE = instructionsCore(false);   // as published while the point lookups are off

test("list_layers keeps the non-commercial flag and notice", () => {
  const out = shapeReadResult("list_layers", {
    data: [
      { id: "kgis_police", licence: "KGIS terms", non_commercial: true, licence_notice: "Non-commercial use only: x", downloads: {} },
      { id: "lgd_states", licence: "CC0-1.0", downloads: {} },
    ],
  });
  assert.equal(out.data[0].non_commercial, true);
  assert.match(out.data[0].licence_notice, /^Non-commercial use only/);
  assert.equal("non_commercial" in out.data[1], false);
  assert.equal("downloads" in out.data[0], false);
});

test("the instructions tell the model to pass the notice on", () => {
  assert.match(INSTRUCTIONS_CORE, /non_commercial/);
  assert.match(INSTRUCTIONS_CORE, /non-commercial use only/i);
});

test("the server identifies itself to the API, so MCP use is counted apart", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(src, /process\.env\.BHARATLAS_MCP_UA \|\| `bharatlas-mcp\/\$\{VERSION\}`/);
  assert.match(src, /"user-agent": USER_AGENT/);
  assert.match(readFileSync(new URL("./test.js", import.meta.url), "utf8"), /BHARATLAS_MCP_UA: "bharatlas-mcp-test"/);
});

test("an id that goes into a URL path must be a plain id (no path tricks)", async () => {
  const { idSegment } = await import("./read-tools.js");
  assert.equal(idSegment("r_8xYz-12", "record_id"), "r_8xYz-12");
  for (const bad of ["../collections/abc/publish?", "a/b", "", "x y", "%2e%2e"]) {
    assert.throws(() => idSegment(bad, "record_id"), /record_id/);
  }
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("./index.js", import.meta.url), "utf8"), /`\/records\/\$\{idSegment\(args\.record_id, "record_id"\)\}\/moderate`/);
});

// spec-data-lifecycle section 8.4: get_layer_detail returns the layer's dated
// releases (`versions`), so an agent can cite the exact version it used.
test("agents are told get_layer_detail lists the citable versions", async () => {
  const { READ_TOOLS } = await import("./read-tools.js");
  const detail = READ_TOOLS.find((t) => t.name === "get_layer_detail");
  assert.match(detail.description, /versions/);
  assert.match(INSTRUCTIONS_CORE, /\*\*Citing\*\*: .*versions.*code.*sha256/s);
});

test("get_layer_detail passes the versions through unchanged", () => {
  const versions = [{ code: "bharatlas-lgd_states-2026.12", released: "2026-12-01", sha256: "ab", w3id: "https://w3id.org/bharatlas/lgd_states/2026.12", url: "https://bharatlas.com/releases/bharatlas-lgd_states-2026.12/" }];
  assert.deepEqual(shapeReadResult("get_layer_detail", { data: { id: "lgd_states", versions } }).data.versions, versions);
});

test("a where column named like a query option travels inside where=", () => {
  const req = readToolRequest("query_layer", { layer_id: "x", where: { format: "pdf", filter: "a", estimate: "1", state: "KA" } });
  assert.equal(req.params.where, "format=pdf,filter=a,estimate=1");
  assert.equal(req.params.state, "KA");
  assert.equal("format" in req.params, false);
  assert.equal("filter" in req.params, false);
});

// Review 2026-11-19: tool arguments are checked. A string where a list belongs
// threw "select.join is not a function"; a where string became one filter per
// character and answered a false "0 rows".
test("a list argument may be a comma-separated string", () => {
  const q = readToolRequest("query_layer", { layer_id: "lgd_states", select: "STNAME, State_LGD", sum: "area" });
  assert.equal(q.params.select, "STNAME,State_LGD");
  assert.equal(q.params.sum, "area");
  const l = readToolRequest("locate", { lat: 12.9, lng: 77.5, layers: "lgd_states,lgd_districts" });
  assert.equal(l.params.layers, "lgd_states,lgd_districts");
  assert.equal(readToolRequest("query_layer", { layer_id: "x", select: ["a", "b"] }).params.select, "a,b");
});

test("a list argument of the wrong type is refused, by name", () => {
  assert.throws(() => readToolRequest("query_layer", { layer_id: "x", select: 5 }), /select must be a list of column names/);
  assert.throws(() => readToolRequest("query_layer", { layer_id: "x", select: [1, {}] }), /select must be a list of column names/);
  assert.throws(() => readToolRequest("locate", { lat: 1, lng: 2, layers: { a: 1 } }), /layers must be a list of layer IDs/);
});

test("where as a col=value string is read as pairs, never per character", () => {
  const q = readToolRequest("query_layer", { layer_id: "lgd_states", where: "STNAME=KERALA" });
  assert.equal(q.params.STNAME, "KERALA");
  assert.equal("0" in q.params, false);
  const two = readToolRequest("query_layer", { layer_id: "x", where: "a=1, b=2" });
  assert.equal(two.params.a, "1");
  assert.equal(two.params.b, "2");
});

test("a where that is not an object or col=value pairs is refused with a clear message", () => {
  for (const where of ["KERALA", ["STNAME", "KERALA"], 5, "=x", { a: { b: 1 } }]) {
    assert.throws(() => readToolRequest("query_layer", { layer_id: "x", where }), /where must be an object of \{column: value\}/, JSON.stringify(where));
  }
  // Numbers and booleans are fine values.
  assert.equal(readToolRequest("query_layer", { layer_id: "x", where: { code: 29, ok: true } }).params.code, 29);
});

// ground_at: what is below a point, in one call (GET /api/v1/ground).
test("ground_at asks /ground with the point and nothing else", () => {
  assert.deepEqual(readToolRequest("ground_at", { lat: 28.525, lng: 77.085, extra: 1 }), { path: "/ground", params: { lat: 28.525, lng: 77.085 } });
  assert.deepEqual(readToolRequest("ground_at", { lat: 1, lng: 2, open_only: true }).params, { lat: 1, lng: 2, open_only: "true" });
});

test("ground_at is a read tool that needs lat and lng", async () => {
  const { READ_TOOLS } = await import("./read-tools.js");
  const t = READ_TOOLS.find((x) => x.name === "ground_at");
  assert.ok(t, "ground_at is offered");
  assert.deepEqual(t.inputSchema.required, ["lat", "lng"]);
  assert.equal(t.annotations.readOnlyHint, true);
  assert.match(t.description, /SoilGrids/);
  assert.match(t.description, /unavailable/);
});

test("the point lookups are named in the instructions only while they are published", async () => {
  const { instructionsCore, readToolsFor } = await import("./read-tools.js");
  assert.doesNotMatch(INSTRUCTIONS_CORE, /ground_at|surface_at/);
  assert.match(instructionsCore(true), /\*\*A point's profile\*\*: ground_at .* surface_at/);
  assert.deepEqual(readToolsFor(false).map((x) => x.name).filter((n) => n.endsWith("_at")), []);
  assert.deepEqual(readToolsFor(true).map((x) => x.name).filter((n) => n.endsWith("_at")), ["ground_at", "surface_at"]);
});

test("surface_at asks /surface", () => {
  assert.deepEqual(readToolRequest("surface_at", { lat: 22.57, lng: 88.36, open_only: true }), { path: "/surface", params: { lat: 22.57, lng: 88.36, open_only: "true" } });
});

test("the npm server offers the point lookups unless BHARATLAS_POINT_PROFILES=off (1.8.0)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./index.js", import.meta.url), "utf8");
  assert.match(src, /const POINT_PROFILES = pointProfilesOn\(process\.env\)/);
  assert.match(src, /readToolsFor\(POINT_PROFILES\)/);
  assert.match(src, /instructionsCore\(POINT_PROFILES\)/);
});

// Lookup filters (owner design, 2026-11-23): the listings say each layer's realm
// and the lookups that read it; ground_at and surface_at read only the sections or
// layers asked for.
test("list_layers passes realm, and keeps realm and lookups in the compact list", async () => {
  assert.deepEqual(readToolRequest("list_layers", { realm: "below" }).params.realm, "below");
  const out = shapeReadResult("list_layers", {
    data: [{ id: "seismic_zones", realm: "below", lookups: { ground: "seismic", surface: "hazards" }, downloads: {} }, { id: "lgd_villages", realm: "ground", downloads: {} }],
  });
  assert.equal(out.data[0].realm, "below");
  assert.deepEqual(out.data[0].lookups, { ground: "seismic", surface: "hazards" });
  assert.equal("lookups" in out.data[1], false);
  const { READ_TOOLS } = await import("./read-tools.js");
  const list = READ_TOOLS.find((t) => t.name === "list_layers");
  assert.deepEqual(list.inputSchema.properties.realm.enum, ["below", "ground", "air"]);
  assert.match(READ_TOOLS.find((t) => t.name === "get_layer_detail").description, /realm/);
});

test("ground_at and surface_at pass sections and layers, as arrays or comma lists", () => {
  assert.deepEqual(readToolRequest("ground_at", { lat: 1, lng: 2, sections: ["soil", "seismic"] }).params, { lat: 1, lng: 2, sections: "soil,seismic" });
  assert.deepEqual(readToolRequest("surface_at", { lat: 1, lng: 2, layers: "airports, dem" }).params, { lat: 1, lng: 2, layers: "airports,dem" });
  assert.throws(() => readToolRequest("surface_at", { lat: 1, lng: 2, sections: [1] }), /sections must be a list/);
});

test("the lookup tools tell agents to narrow a narrow question and read everything for a broad one", async () => {
  const { READ_TOOLS } = await import("./read-tools.js");
  for (const name of ["ground_at", "surface_at"]) {
    const t = READ_TOOLS.find((x) => x.name === name);
    assert.ok(t.inputSchema.properties.sections, name);
    assert.ok(t.inputSchema.properties.layers, name);
    assert.match(t.description, /narrow question.*sections/i, name);
    assert.match(t.description, /broad/i, name);
  }
  assert.deepEqual(READ_TOOLS.find((x) => x.name === "ground_at").inputSchema.properties.sections.items.enum,
    ["seismic", "geology", "resources", "groundwater", "soil", "subsidence", "underground", "watershed"]);
  assert.deepEqual(READ_TOOLS.find((x) => x.name === "surface_at").inputSchema.properties.sections.items.enum,
    ["place", "land", "climate", "water", "hazards", "protected", "access", "services", "infrastructure"]);
});

// 1.8.0 (24 Nov 2026): the point lookups are live on the API since 22 Nov, so the
// npm server offers them unless switched off; answers reach the model compact and
// without the server's own timings; a read that meets a passing 429/502/503 is
// tried once more.
import { pointProfilesOn, resultText, withRetry } from "./read-tools.js";

test("ground_at and surface_at are offered unless BHARATLAS_POINT_PROFILES=off", () => {
  assert.equal(pointProfilesOn({}), true);
  assert.equal(pointProfilesOn({ BHARATLAS_POINT_PROFILES: "on" }), true);
  assert.equal(pointProfilesOn({ BHARATLAS_POINT_PROFILES: "off" }), false);
});

test("answers are compact JSON; big integers are numbers", () => {
  assert.equal(resultText({ a: [1, 2], b: { c: "x" }, n: 3n }), '{"a":[1,2],"b":{"c":"x"},"n":3}');
});

test("the server's timings are left out of what the model reads", () => {
  const out = shapeReadResult("surface_at", { point: { lat: 1, lng: 2 }, sections: {}, timing_ms: 812, layer_timing_ms: { a: 3 } });
  assert.deepEqual(out, { point: { lat: 1, lng: 2 }, sections: {} });
  const q = shapeReadResult("query_layer", { data: { total: 1, rows: [] }, layer_id: "x", timing_ms: 40 });
  assert.deepEqual(q, { data: { total: 1, rows: [] }, layer_id: "x" });
  const n = shapeReadResult("nearby", { total: 2, features: [], timing_ms: 9, rows_scanned: 100 });
  assert.deepEqual(n, { total: 2, features: [], rows_scanned: 100 });
});

test("a read is tried once more after a 429, 502 or 503, never after other errors", async () => {
  const run = async (statuses) => {
    let calls = 0;
    const res = await withRetry(async () => ({ status: statuses[calls++] ?? 200 }), { delayMs: 0 });
    return { calls, status: res.status };
  };
  assert.deepEqual(await run([503]), { calls: 2, status: 200 });
  assert.deepEqual(await run([429]), { calls: 2, status: 200 });
  assert.deepEqual(await run([502, 502]), { calls: 2, status: 502 });  // once only
  assert.deepEqual(await run([500]), { calls: 1, status: 500 });
  assert.deepEqual(await run([400]), { calls: 1, status: 400 });
  assert.deepEqual(await run([200]), { calls: 1, status: 200 });
});
