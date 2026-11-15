// Unit tests for import_points' record shaping (no network). Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { withClientIds, importSummary } from "./import-records.js";

const g = { type: "Point", coordinates: [77.59, 12.97] };

test("client_id_field names the property that carries each row's id", () => {
  const out = withClientIds([{ geometry: g, properties: { code: 101, name: "A" } }], "code");
  assert.equal(out[0].client_id, "101");
  assert.deepEqual(out[0].properties, { code: 101, name: "A" });
});

test("by default the feature id is the client id, then an `id` property", () => {
  const out = withClientIds([
    { type: "Feature", id: "f-1", geometry: g, properties: { id: "p-1" } },
    { geometry: g, properties: { id: 7 } },
    { geometry: g, properties: { name: "no id" } },
  ]);
  assert.deepEqual(out.map((r) => r.client_id), ["f-1", "7", undefined]);
});

test("a client_id already on the record wins; an empty client_id_field turns the default off", () => {
  assert.equal(withClientIds([{ client_id: "mine", id: "f", geometry: g, properties: {} }], "id")[0].client_id, "mine");
  assert.equal(withClientIds([{ id: "f", geometry: g, properties: { id: "p" } }], "")[0].client_id, undefined);
});

test("blank and non-scalar ids are left out (the server would refuse them)", () => {
  const out = withClientIds([
    { geometry: g, properties: { code: "  " } },
    { geometry: g, properties: { code: { a: 1 } } },
    { geometry: g, properties: { code: Number.NaN } },
  ], "code");
  assert.deepEqual(out.map((r) => r.client_id), [undefined, undefined, undefined]);
});

test("the summary names added, updated and unchanged", () => {
  assert.equal(
    importSummary({ added: 1, updated: 2, unchanged: 3, total: 7, errors: [{ index: 0, error: "x" }] }, 1),
    "1 added, 2 updated, 3 unchanged of 7 rows; 1 refused (see errors). 1 row had no client_id, so re-running adds it again.",
  );
  assert.equal(importSummary({ added: 3, updated: 0, unchanged: 0, total: 3, errors: [] }, 0), "3 added, 0 updated, 0 unchanged of 3 rows.");
});
