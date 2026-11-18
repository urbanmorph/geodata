// Non-commercial layers must say so to the model too (owner, 2026-11-15): the
// API marks them with non_commercial + licence_notice, and the MCP keeps both
// in the compact layer list and tells the model what they mean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeReadResult, INSTRUCTIONS_CORE } from "./read-tools.js";

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
