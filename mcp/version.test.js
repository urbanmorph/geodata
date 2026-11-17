// One MCP version everywhere it is written (they had drifted: npm 1.5.0, the
// server said 1.4.0, the Claude Code plugin pinned 1.3.0). Release runbook:
// bump every one of these together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const json = (p) => JSON.parse(read(p));

test("package, lockfile, server.json, Server(), plugin, plugin pin, skill and /.well-known agree", () => {
  const v = json("./package.json").version;
  const found = {
    "package-lock.json": json("./package-lock.json").version,
    "package-lock.json packages['']": json("./package-lock.json").packages[""].version,
    "server.json": json("./server.json").version,
    "server.json package": json("./server.json").packages[0].version,
    "index.js Server()": read("./index.js").match(/name: "bharatlas-mcp", version: "([^"]+)"/)[1],
    "plugin.json": json("../plugins/claude-code/.claude-plugin/plugin.json").version,
    ".mcp.json pin": read("../plugins/claude-code/.mcp.json").match(/bharatlas-mcp@([0-9.]+)/)[1],
    "SKILL.md": read("../plugins/claude-code/skills/bharatlas/SKILL.md").match(/^version: (.+)$/m)[1],
    "/.well-known/mcp.json": json("../web/public/.well-known/mcp.json").version,
  };
  for (const [where, got] of Object.entries(found)) assert.equal(got, v, where);
});
