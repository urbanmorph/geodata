// A collect share link's id goes into collect API paths, so only a plain id
// is accepted (review 2026-11-19): a crafted link can't walk to another endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShareLink, atLeastScope } from "./collect-links.js";

test("a share link gives its id, scope and token", () => {
  const p = parseShareLink("https://collect.bharatlas.com/c/AbC_12-x/admin#adm_secret");
  assert.deepEqual({ id: p.id, scope: p.scope, token: p.token }, { id: "AbC_12-x", scope: "admin", token: "adm_secret" });
});

test("an id that is not a plain id is refused", () => {
  for (const link of [
    "https://collect.bharatlas.com/c/x%2F..%2Fother#adm_t",
    "https://collect.bharatlas.com/c/a%3Fb/admin#adm_t",
    "https://collect.bharatlas.com/c/__proto__.x#viw_t",
  ]) assert.throws(() => parseShareLink(link), /map id must be an id/, link);
});

test("scopes rank view < edit < admin", () => {
  assert.equal(atLeastScope("admin", "edit"), true);
  assert.equal(atLeastScope("view", "admin"), false);
  assert.equal(atLeastScope(undefined, "view"), false);
});
