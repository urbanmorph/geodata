// Locate enrichment (Phase 4). Two pure helpers used by the record handlers:
//   representativeCoord — pick one [lng,lat] from any geometry to query locate
//   distillAdminCtx     — flatten /api/v1/locate `results` to a small named map
// stored in records.admin_ctx and surfaced in the review queue + published output.

export type AdminCtx = Record<string, string>;

// Per admin level, the property key(s) that hold its display name, in order of
// preference. Only these known levels are kept — admin_ctx stays small + stable.
const NAME_KEYS: Record<string, string[]> = {
  state: ['STNAME', 'stname', 'state'],
  district: ['dtname', 'Dist', 'district'],
  subdistrict: ['sdtname'],
  block: ['block_name'],
  parliament_constituency: ['pc_name'],
  assembly_constituency: ['ac_name'],
  high_court: ['name', 'short_name'],
  seismic_zone: ['seismic_zo'],
};

interface LocateEntry {
  level?: unknown;
  feature?: { properties?: Record<string, unknown> };
}

function nameFor(level: string, props: Record<string, unknown>): string | null {
  for (const key of NAME_KEYS[level] ?? []) {
    const v = props[key];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/** Flatten a locate `results` object to `{level: name}`; null if nothing known resolves. */
export function distillAdminCtx(results: unknown): AdminCtx | null {
  if (!results || typeof results !== 'object') return null;
  const ctx: AdminCtx = {};
  for (const group of Object.values(results as Record<string, unknown>)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group as LocateEntry[]) {
      const level = entry?.level;
      if (typeof level !== 'string' || !(level in NAME_KEYS)) continue;
      const name = nameFor(level, entry?.feature?.properties ?? {});
      if (name) ctx[level] = name;
    }
  }
  return Object.keys(ctx).length ? ctx : null;
}

/**
 * Merge enrichment into a record's properties for the published output: each
 * admin level (state, district…) becomes a top-level property, but an author
 * field of the same key always wins. Returns a new object; input untouched.
 */
export function mergeAdminCtx(
  properties: Record<string, unknown>,
  adminCtxJson: string | null,
): Record<string, unknown> {
  if (!adminCtxJson) return properties;
  let ctx: AdminCtx;
  try {
    ctx = JSON.parse(adminCtxJson) as AdminCtx;
  } catch {
    return properties;
  }
  const out = { ...properties };
  for (const [k, v] of Object.entries(ctx)) if (!(k in out)) out[k] = v;
  return out;
}

/** First [lng,lat] vertex of any GeoJSON geometry; null if none/malformed. */
export function representativeCoord(geometry: unknown): [number, number] | null {
  const g = geometry as { coordinates?: unknown } | null;
  if (!g || typeof g !== 'object') return null;
  let found: [number, number] | null = null;
  const walk = (node: unknown): void => {
    if (found || !Array.isArray(node)) return;
    if (typeof node[0] === 'number' && typeof node[1] === 'number') {
      found = [node[0], node[1]];
      return;
    }
    for (const child of node) walk(child);
  };
  walk(g.coordinates);
  return found;
}
