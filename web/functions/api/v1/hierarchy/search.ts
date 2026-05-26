import type { Env } from '../../_middleware';

const CACHE = 'public, max-age=3600, stale-while-revalidate=86400';

export const onRequestGet: PagesFunction<Env> = async (ctx) => {
  const url = new URL(ctx.request.url);
  const q = url.searchParams.get('q');
  if (!q || q.length < 2) {
    return json(400, { error: 'q param required (min 2 chars)', status: 400 });
  }

  const level = url.searchParams.get('level');
  const stateCode = url.searchParams.get('state');
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '10', 10), 1), 50);

  if (!stateCode) {
    return json(400, { error: 'state query param is required for hierarchy search', status: 400 });
  }

  try {
    const r = await fetch(`${url.origin}/api-data/hierarchy/${stateCode}.json`);
    if (!r.ok) {
      return json(404, { error: `No hierarchy data for state ${stateCode}`, status: 404 });
    }
    const hierarchy = await r.json() as Record<string, Record<string, { name: string; lgd_code: number; [k: string]: unknown }>>;

    const qLower = q.toLowerCase();
    const results: Array<{ lgd_code: number; name: string; level: string }> = [];

    const levelsToSearch = level ? [level + 's'] : ['districts', 'subdistricts', 'blocks', 'villages'];

    for (const lvlKey of levelsToSearch) {
      const bucket = hierarchy[lvlKey];
      if (!bucket) continue;
      const lvl = lvlKey.replace(/s$/, '');
      for (const entry of Object.values(bucket)) {
        if (results.length >= limit) break;
        if (entry.name && entry.name.toLowerCase().includes(qLower)) {
          results.push({ lgd_code: entry.lgd_code, name: entry.name, level: lvl });
        }
      }
      if (results.length >= limit) break;
    }

    return new Response(JSON.stringify({ data: results, total: results.length }), {
      headers: { 'content-type': 'application/json', 'cache-control': CACHE },
    });
  } catch {
    return json(404, { error: 'Hierarchy data not available. Run scripts/build_api_indexes.py to generate.', status: 404 });
  }
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
