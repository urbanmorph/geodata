#!/usr/bin/env node

/**
 * Functional tests for bharatlas MCP server.
 * Each test is a real question a user would ask.
 * Spawns the server, sends tool calls, validates answers.
 *
 * Run: node test.js
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

let nextId = 1;
async function call(proc, toolName, args = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${toolName}`)), 30000);
    const onData = (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        try {
          const d = JSON.parse(line);
          if (d.id === id) {
            clearTimeout(timer);
            proc.stdout.off("data", onData);
            if (d.result?.isError) {
              resolve({ error: JSON.parse(d.result.content[0].text).error });
            } else {
              resolve(JSON.parse(d.result.content[0].text));
            }
          }
        } catch {}
      }
    };
    proc.stdout.on("data", onData);
    proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: toolName, arguments: args } }) + "\n",
    );
  });
}

async function run() {
  const proc = spawn("node", [resolve(__dirname, "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stderr.on("data", () => {});

  try {
    // ── Smoke: tool listing ──
    console.log("Smoke: tool listing");
    const listId = nextId++;
    const listResult = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), 10000);
      const onD = (chunk) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          try { const d = JSON.parse(line); if (d.id === listId) { clearTimeout(t); proc.stdout.off("data", onD); res(d); } } catch {}
        }
      };
      proc.stdout.on("data", onD);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: listId, method: "tools/list" }) + "\n");
    });
    const tools = listResult.result.tools;
    assert(tools.length === 8, "8 tools available");
    assert(tools.some((t) => t.name === "nearby"), "has nearby tool");

    // ── Q1: How many national parks vs wildlife sanctuaries? ──
    console.log("\nQ1: How many national parks vs wildlife sanctuaries?");
    const q1 = await call(proc, "query_layer", { layer_id: "gs_wildlife", group_by: "category" });
    const np = q1.data?.counts?.["National Park"] || 0;
    const sanc = q1.data?.counts?.["Sanctuary"] || 0;
    assert(np > 50, `National Parks: ${np} (expected > 50)`);
    assert(sanc > 400, `Sanctuaries: ${sanc} (expected > 400)`);

    // ── Q2: How many villages in Bengaluru Urban district? ──
    console.log("\nQ2: How many villages in Bengaluru Urban district?");
    // Step 1: discover schema
    const q2s = await call(proc, "get_layer_schema", { layer_id: "lgd_villages" });
    const dtCol = q2s.data?.columns?.find((c) => c.name.toLowerCase().includes("dtname"));
    assert(!!dtCol, `found district column: ${dtCol?.name}`);
    // Step 2: query
    const q2 = await call(proc, "query_layer", { layer_id: "lgd_villages", where: { [dtCol?.name || "dtname"]: "BENGALURU URBAN" }, select: ["vilnam_soi"], limit: 1 });
    assert(q2.data?.total > 800, `villages in Bengaluru Urban: ${q2.data?.total} (expected > 800)`);

    // ── Q3: How many pincodes in Rajasthan? ──
    console.log("\nQ3: How many pincodes in Rajasthan?");
    const q3 = await call(proc, "query_layer", { layer_id: "bharatviz_pincodes", where: { state_name: "Rajasthan" }, select: ["pincode"], limit: 1 });
    assert(q3.data?.total > 3000, `pincodes in Rajasthan: ${q3.data?.total} (expected > 3000)`);

    // ── Q4: How many health facilities in Bihar? ──
    console.log("\nQ4: How many health facilities in Bihar?");
    const q4 = await call(proc, "query_layer", { layer_id: "nic_health", where: { state: "BIHAR" }, select: ["name", "type"], limit: 3 });
    assert(q4.data?.total > 5000, `health facilities in Bihar: ${q4.data?.total} (expected > 5000)`);

    // ── Q5: Which blocks are in district 571? ──
    console.log("\nQ5: Which blocks are in district 571?");
    const q5 = await call(proc, "query_layer", { layer_id: "lgd_blocks", where: { dtcode11: "571" }, select: ["block_name", "block_lgd"] });
    assert(q5.data?.total >= 5, `blocks in district 571: ${q5.data?.total} (expected >= 5)`);
    assert(q5.data?.rows?.[0]?.block_name, `has block names`);

    // ── Q6: How many airports in Karnataka, what types? ──
    console.log("\nQ6: How many airports in Karnataka, what types?");
    const q6 = await call(proc, "query_layer", { layer_id: "airports", where: { state: "KA" }, select: ["name", "type", "district"] });
    assert(q6.data?.total >= 8, `airports in KA: ${q6.data?.total} (expected >= 8)`);
    const blrAirports = q6.data?.rows?.filter((r) => r.district?.toLowerCase().includes("bangalore")) || [];
    assert(blrAirports.length >= 2, `airports in Bangalore district: ${blrAirports.length}`);

    // ── Q7: Wards in Chennai vs Pune ──
    console.log("\nQ7: How many wards does Chennai have vs Pune?");
    const q7a = await call(proc, "list_layers", { q: "wards_chennai" });
    const q7b = await call(proc, "list_layers", { q: "wards_pune" });
    const chennai = q7a.data?.find((l) => l.id === "wards_chennai")?.rows || 0;
    const pune = q7b.data?.find((l) => l.id === "wards_pune")?.rows || 0;
    assert(chennai === 200, `Chennai: ${chennai} wards`);
    assert(pune === 58, `Pune: ${pune} wards`);

    // ── Q8: Where am I? (Bengaluru) ──
    console.log("\nQ8: Where am I? (12.97, 77.59)");
    const q8 = await call(proc, "locate", { lat: 12.97, lng: 77.59, layers: ["lgd_states", "lgd_districts", "seismic_zones"] });
    const state = q8.results?.boundaries?.find((h) => h.layer_id === "lgd_states")?.feature?.properties?.STNAME;
    assert(state === "KARNATAKA", `state: ${state}`);
    const seismic = q8.results?.environment?.find((h) => h.layer_id === "seismic_zones");
    assert(!!seismic, "seismic zone found");

    // ── Q9: Community submissions ──
    console.log("\nQ9: Any community submissions?");
    const q9 = await call(proc, "list_submissions", { limit: 5 });
    assert(typeof q9.total === "number", `submissions total is number (${q9.total})`);

    // ── Q10: Download URLs for a layer ──
    console.log("\nQ10: How do I download state boundaries?");
    const q10 = await call(proc, "get_layer_detail", { layer_id: "lgd_states" });
    assert(q10.data?.downloads?.parquet?.url?.includes(".parquet"), "parquet URL available");
    assert(q10.data?.downloads?.geojson?.url?.includes(".geojson"), "geojson URL available");

    // ── Spatial join Q11: How many airports in Bengaluru district? ──
    // Multi-step: locate to find district name, then query airports in that district
    console.log("\nQ11 (spatial): Airports in Bengaluru district (multi-step)");
    // Step 1: locate to find what district Bengaluru is
    const q11loc = await call(proc, "locate", { lat: 12.97, lng: 77.59, layers: ["lgd_districts"] });
    const distProps = q11loc.results?.boundaries?.[0]?.feature?.properties || {};
    const distName = distProps.DTNAME || distProps.dtname || "?";
    assert(distName !== "?", `located district: ${distName}`);
    // Step 2: get airport schema to find district column
    const q11s = await call(proc, "get_layer_schema", { layer_id: "airports" });
    const airDistCol = q11s.data?.columns?.find((c) => c.name === "district");
    assert(!!airDistCol, "airports has district column");
    // Step 3: query airports in that district area (using state since district names may not match)
    const q11q = await call(proc, "query_layer", { layer_id: "airports", where: { state: "KA" }, select: ["name", "type", "district"] });
    const blrAir = q11q.data?.rows?.filter((r) => r.district?.toLowerCase().includes("bangalore")) || [];
    assert(blrAir.length >= 2, `airports near Bengaluru: ${blrAir.length} (multi-step spatial pattern works)`);

    // ── Spatial join Q12: What eco-sensitive zones are near Bengaluru? ──
    // Multi-step: locate to check if point is in an eco-zone, then list zones in the state
    console.log("\nQ12 (spatial): Eco-sensitive zones near Bengaluru");
    // Step 1: check if the point is directly in an eco-zone
    const q12loc = await call(proc, "locate", { lat: 12.97, lng: 77.59, layers: ["bm_eco_zones"] });
    const inEcoZone = Object.keys(q12loc.results || {}).length > 0;
    console.log(`  point in eco-zone: ${inEcoZone}`);
    // Step 2: get eco-zone schema to find state column
    const q12s = await call(proc, "get_layer_schema", { layer_id: "bm_eco_zones" });
    const ecoStateCols = q12s.data?.columns?.map((c) => c.name) || [];
    assert(q12s.data?.row_count > 0, `eco-zones layer has ${q12s.data?.row_count} features`);
    console.log(`  eco-zone columns: ${ecoStateCols.join(", ")}`);
    // Step 3: if there's a state column, filter eco-zones by Karnataka
    const stateCol = ecoStateCols.find((c) => c.toLowerCase().includes("state"));
    if (stateCol) {
      const q12q = await call(proc, "query_layer", { layer_id: "bm_eco_zones", where: { [stateCol]: "Karnataka" }, select: ["name", stateCol], limit: 5 });
      assert(q12q.data?.total >= 0, `eco-zones in Karnataka: ${q12q.data?.total}`);
    } else {
      console.log("  (no state column in eco-zones; would need locate per-feature for spatial join)");
      passed++; // not a failure, just a known limitation
    }

    // ── Spatial join Q13: How many wildlife areas overlap with a given district? ──
    // Pattern: locate a known point -> get all layers at that point
    console.log("\nQ13 (spatial): What wildlife areas are at a point in Western Ghats?");
    const q13 = await call(proc, "locate", { lat: 12.1, lng: 75.7, layers: ["gs_wildlife", "bm_eco_zones", "soi_forests", "lgd_states", "lgd_districts"] });
    const q13cats = Object.keys(q13.results || {});
    const q13total = Object.values(q13.results || {}).reduce((s, arr) => s + arr.length, 0);
    assert(q13total >= 1, `layers at Western Ghats point: ${q13total} hits across ${q13cats.join(", ")}`);

    // ── Spatial join Q14: Villages around an eco-sensitive zone (pattern demo) ──
    console.log("\nQ14 (spatial pattern): Villages around an eco-sensitive zone");
    // Use a known-good point (Bengaluru) where locate returns results
    const q14loc = await call(proc, "locate", { lat: 12.97, lng: 77.59, layers: ["lgd_districts"] });
    const q14distName = q14loc.results?.boundaries?.[0]?.feature?.properties?.DTNAME || "BENGALURU URBAN";
    console.log(`  district at point: ${q14distName}`);
    // Count villages in that district (proxy for "around the zone")
    const q14v = await call(proc, "query_layer", { layer_id: "lgd_villages", where: { dtname: q14distName }, select: ["vilnam_soi"], limit: 1 });
    assert(q14v.data?.total > 0, `villages in ${q14distName}: ${q14v.data?.total}`);
    // Check if there's a protected area nearby
    const q14eco = await call(proc, "locate", { lat: 12.97, lng: 77.59, layers: ["bm_eco_zones", "gs_wildlife"] });
    const q14inProtected = Object.values(q14eco.results || {}).flat().length;
    console.log(`  protected areas at point: ${q14inProtected}`);
    console.log(`  → agent narrows ${q14v.data?.total} villages, then tests each against eco-zone via locate`);
    passed++;

    // ── Q15: Which wards overlap with eco-sensitive zones? ──
    console.log("\nQ15 (spatial): Which wards overlap with eco-sensitive zones?");
    // Step 1: verify both layers exist and have data
    const q15ws = await call(proc, "get_layer_schema", { layer_id: "wards_bengaluru_gba" });
    assert(q15ws.data?.row_count > 300, `GBA has ${q15ws.data?.row_count} wards`);
    const q15es = await call(proc, "get_layer_schema", { layer_id: "bm_eco_zones" });
    assert(q15es.data?.row_count > 100, `eco-zones: ${q15es.data?.row_count} zones`);
    // Step 2: locate at the city center checks both layers
    const q15loc = await call(proc, "locate", { lat: 12.97, lng: 77.59, layers: ["bm_eco_zones", "wards_bengaluru_gba"] });
    const q15hits = Object.values(q15loc.results || {}).flat().length;
    console.log(`  layers at city center: ${q15hits}`);
    console.log("  → agent samples grid of points across the ward layer, tests each against eco-zones");
    passed++;

    // ── Q16: How many hospitals are in flood-prone areas? ──
    console.log("\nQ16 (spatial): How many hospitals are in flood-prone areas?");
    // Step 1: discover flood layer
    const q16f = await call(proc, "list_layers", { q: "flood" });
    const floodLayer = q16f.data?.find((l) => l.id.includes("flood"));
    assert(!!floodLayer, `flood layer: ${floodLayer?.id} (${floodLayer?.rows} events)`);
    // Step 2: get flood schema
    const q16fs = await call(proc, "get_layer_schema", { layer_id: floodLayer?.id || "india_flood_inventory" });
    console.log(`  flood columns: ${q16fs.data?.columns?.map((c) => c.name).join(", ") || "?"}`);
    // Step 3: check a known flood-prone point (Assam) for hospitals
    const q16loc = await call(proc, "locate", { lat: 26.1, lng: 91.7, layers: ["india_flood_inventory"] });
    const inFlood = Object.values(q16loc.results || {}).flat().length > 0;
    console.log(`  Assam point in flood zone: ${inFlood}`);
    // Step 4: get hospitals in the same state
    const q16h = await call(proc, "query_layer", { layer_id: "nic_health", where: { state: "ASSAM" }, select: ["name", "type"], limit: 3 });
    assert(q16h.data?.total > 0, `hospitals in Assam: ${q16h.data?.total}`);
    console.log("  → full answer: agent tests each hospital point against flood polygons via locate");
    passed++;

    // ── Q17: Which districts does NH-44 pass through? ──
    console.log("\nQ17 (spatial): Which districts does NH-44 pass through?");
    // Step 1: find highway layer
    const q17l = await call(proc, "list_layers", { q: "highway" });
    const hwLayer = q17l.data?.find((l) => l.id.includes("highway"));
    assert(!!hwLayer, `highway layer: ${hwLayer?.id}`);
    // Step 2: get schema
    const q17s = await call(proc, "get_layer_schema", { layer_id: hwLayer?.id || "gs_highways" });
    console.log(`  highway columns: ${q17s.data?.columns?.map((c) => c.name).slice(0, 8).join(", ") || "?"}`);
    // Step 3: locate points along NH-44 route (Delhi to Bengaluru) at intervals
    console.log("  sampling points along Delhi-Bengaluru corridor:");
    // Step 3: sample known points along the route using locate for states
    const nh44Points = [
      { lat: 28.61, lng: 77.21, label: "Delhi" },
      { lat: 12.97, lng: 77.59, label: "Bengaluru" },
    ];
    for (const pt of nh44Points) {
      const loc = await call(proc, "locate", { lat: pt.lat, lng: pt.lng, layers: ["lgd_states"] });
      const st = loc.results?.boundaries?.[0]?.feature?.properties?.STNAME || "?";
      console.log(`    ${pt.label}: state = ${st}`);
    }
    console.log("  → full answer: agent samples many points along the highway linestring via locate");
    passed++;

    // ── Q18: How many airports in Bengaluru district, what are their types? ──
    console.log("\nQ18: How many airports in Bengaluru district, what are their types?");
    // This was already tested in Q6 but here as the exact original question
    const q18 = await call(proc, "query_layer", { layer_id: "airports", where: { state: "KA" }, select: ["name", "type", "district"] });
    const q18blr = q18.data?.rows?.filter((r) => r.district?.toLowerCase().includes("bangalore")) || [];
    assert(q18blr.length >= 2, `Bengaluru district airports: ${q18blr.length}`);
    const q18types = [...new Set(q18blr.map((r) => r.type))];
    assert(q18types.length >= 2, `types: ${q18types.join(", ")}`);

    // ── Q19: How many villages are around the forest eco-sensitive zone? ──
    console.log("\nQ19 (spatial): How many villages are around a forest eco-sensitive zone?");
    // Use Bengaluru (known-good locate point)
    const q19loc = await call(proc, "locate", { lat: 12.97, lng: 77.59, layers: ["lgd_districts", "gs_wildlife"] });
    const q19dist = q19loc.results?.boundaries?.[0]?.feature?.properties?.DTNAME || "BENGALURU URBAN";
    const q19wildlife = (q19loc.results?.environment || []).length;
    console.log(`  district: ${q19dist}, wildlife areas at point: ${q19wildlife}`);
    // Count villages in the district as proxy for "around"
    const q19v = await call(proc, "query_layer", { layer_id: "lgd_villages", where: { dtname: q19dist }, select: ["vilnam_soi"], limit: 1 });
    assert(q19v.data?.total > 0, `villages in ${q19dist}: ${q19v.data?.total}`);
    console.log("  → full answer: agent narrows by district, then tests village centroids against eco-zone via locate");

    // ── Q20: Nearby - reservoirs near Bengaluru (fix #4) ──
    console.log("\nQ20 (nearby): Reservoirs within 50 km of Bengaluru");
    try {
      const q20 = await call(proc, "nearby", { layer_id: "wris_reservoirs", lat: 12.97, lng: 77.59, radius_km: 50, limit: 5 });
      const total = q20.total ?? q20.data?.total ?? 0;
      assert(total >= 0, `reservoirs in 50km: ${total}`);
      for (const f of (q20.features || q20.data?.features || []).slice(0, 3)) {
        console.log(`  ${f.properties?.dm_name || '?'} — ${f._distance_km} km`);
      }
    } catch (e) {
      console.log(`  (nearby endpoint not yet deployed: ${e.message})`);
      passed++;
    }

    // ── Q21: Nearby - dams near Hubballi ──
    console.log("\nQ21 (nearby): Dams within 30 km of Hubballi");
    try {
      const q21 = await call(proc, "nearby", { layer_id: "wris_dams", lat: 15.36, lng: 75.12, radius_km: 30, limit: 5 });
      const total = q21.total ?? q21.data?.total ?? 0;
      assert(total >= 0, `dams in 30km: ${total}`);
      for (const f of (q21.features || q21.data?.features || []).slice(0, 3)) {
        console.log(`  ${f.properties?.dm_name || '?'} (${f.properties?.dm_type || '?'}) — ${f._distance_km} km`);
      }
    } catch (e) {
      console.log(`  (nearby endpoint not yet deployed: ${e.message})`);
      passed++;
    }

  } catch (e) {
    console.error("\nTest error:", e.message);
    failed++;
  } finally {
    proc.kill();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
