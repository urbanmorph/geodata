import type { Env } from '../../_middleware';

const CACHE = 'public, max-age=86400, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const code = url.searchParams.get('code');
  const level = url.searchParams.get('level');

  if (!code || !level) {
    return json(400, { error: 'code and level query params are required', status: 400 });
  }

  const validLevels = ['state', 'district', 'subdistrict', 'block', 'village'];
  if (!validLevels.includes(level)) {
    return json(400, { error: `level must be one of: ${validLevels.join(', ')}`, status: 400 });
  }

  // Determine which state file to load. For state-level, code IS the state code.
  // For sub-state levels, we need to search or the caller provides ?state=.
  const stateCode = url.searchParams.get('state') || (level === 'state' ? code : null);

  if (!stateCode) {
    return json(400, { error: 'state query param is required for sub-state levels (or use level=state)', status: 400 });
  }

  try {
    const r = await fetch(`${url.origin}/api-data/hierarchy/${stateCode}.json`);
    if (!r.ok) {
      return json(404, { error: `No hierarchy data for state ${stateCode}`, status: 404 });
    }
    const hierarchy = await r.json() as Record<string, Record<string, { name: string; lgd_code: number; [k: string]: unknown }>>;

    const levelKey = level + 's'; // 'districts', 'villages', etc.
    const bucket = hierarchy[levelKey] || hierarchy[level];
    if (!bucket) {
      return json(404, { error: `No ${level} data in hierarchy for state ${stateCode}`, status: 404 });
    }

    // Find the entry by LGD code
    const entry = Object.values(bucket).find(
      (e: Record<string, unknown>) => String(e.lgd_code) === String(code),
    );
    if (!entry) {
      return json(404, { error: `Code ${code} not found at level ${level} in state ${stateCode}`, status: 404 });
    }

    // Build the chain from the entry's parent references
    const chain: Record<string, unknown> = { [level]: entry };
    if (entry.district_lgd && hierarchy.districts) {
      const d = Object.values(hierarchy.districts).find(
        (e: Record<string, unknown>) => String(e.lgd_code) === String(entry.district_lgd),
      );
      if (d) chain.district = d;
    }
    if (entry.subdistrict_lgd && hierarchy.subdistricts) {
      const s = Object.values(hierarchy.subdistricts).find(
        (e: Record<string, unknown>) => String(e.lgd_code) === String(entry.subdistrict_lgd),
      );
      if (s) chain.subdistrict = s;
    }
    if (entry.block_lgd && hierarchy.blocks) {
      const b = Object.values(hierarchy.blocks).find(
        (e: Record<string, unknown>) => String(e.lgd_code) === String(entry.block_lgd),
      );
      if (b) chain.block = b;
    }
    const stateEntry = hierarchy.state || hierarchy.states;
    if (stateEntry) chain.state = stateEntry;

    return new Response(JSON.stringify({ data: chain }), {
      headers: { 'content-type': 'application/json', 'cache-control': CACHE },
    });
  } catch {
    return json(404, { error: 'Hierarchy data not available. Run scripts/build_api_indexes.py to generate.', status: 404 });
  }
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
