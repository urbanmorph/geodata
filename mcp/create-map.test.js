// A map always carries a licence: CC0 when the caller names none, and the answer says
// which licence the map got (owner, 2026-11-20).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMapBody, DEFAULT_LICENCE } from "./create-map.js";

const ARGS = { name: "Trees", purpose: "Street trees", geometry: ["point"], fields: [] };

test("no licence given: CC0, and the note says so and how to choose another", () => {
  const { body, licenceNote } = createMapBody(ARGS);
  assert.equal(DEFAULT_LICENCE, "CC0-1.0");
  assert.equal(body.license, "CC0-1.0");
  assert.match(licenceNote, /CC0-1\.0 \(public domain\), the default/);
  assert.match(licenceNote, /before the map has points/);
});

test("a licence given is used and named", () => {
  const { body, licenceNote } = createMapBody({ ...ARGS, license: "CC-BY-4.0" });
  assert.equal(body.license, "CC-BY-4.0");
  assert.equal(licenceNote, "Licence: CC-BY-4.0.");
});

test("the body carries the form, mode and moderation as before", () => {
  const { body } = createMapBody({ ...ARGS, mode: "photos_ai", category: "environment", moderation: false });
  assert.deepEqual(body.schema_doc, { version: 1, geometry: ["point"], fields: [], category: "environment", mode: "photos_ai" });
  assert.equal(body.moderation, 0);
});
