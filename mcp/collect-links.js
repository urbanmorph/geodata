// Collect share links: https://collect.bharatlas.com/c/<id>[/admin]#<token>.
// The token's prefix is its scope; the id goes into collect API paths, so it
// must be a plain id (idSegment).
import { idSegment } from "./read-tools.js";

const SCOPE_BY_PREFIX = { adm: "admin", edt: "edit", viw: "view" };
const SCOPE_RANK = { view: 0, edit: 1, admin: 2 };
export const scopeOfToken = (t) => SCOPE_BY_PREFIX[String(t || "").slice(0, 3)] || null;
export const atLeastScope = (have, need) => (SCOPE_RANK[have] ?? -1) >= SCOPE_RANK[need];

export function parseShareLink(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { throw new Error("not a valid URL — paste the whole collect share link"); }
  const token = (u.hash || "").replace(/^#/, "");
  const scope = scopeOfToken(token);
  if (!scope) throw new Error("no token found in the link #fragment (expected #adm_… / #edt_… / #viw_…)");
  const parts = u.pathname.split("/").filter(Boolean); // ["c", "<id>", "admin"?]
  const ci = parts.indexOf("c");
  const id = ci >= 0 ? parts[ci + 1] : null;
  if (!id) throw new Error("could not find the map id in the link path (expected /c/<id>…)");
  return { id: idSegment(id, "map id"), token, scope, link: u.toString() };
}
