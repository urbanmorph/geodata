// Purge Cloudflare's edge cache for the pages a deploy changes.
//
// Pages carry stale-while-revalidate=86400 (_headers), so without this a
// location can serve the previous version for up to a day after a deploy.
// CI runs this right after `wrangler pages deploy` (.github/workflows/ci.yml).
//
//   CLOUDFLARE_API_TOKEN (needs Zone → Cache Purge) and CF_ZONE_ID in the env;
//   node scripts/purge-cache.mjs          (from web/)
//
// Purge by URL, 30 per request (the per-call limit on this plan). A failure
// is reported as a CI warning and does not fail the job: the deploy already
// succeeded, and the cache still refreshes on its own within a day.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGES = ['/', '/index.html', '/about', '/docs', '/preview', '/mcp', '/privacy', '/terms'];
const FILES = ['/catalog.json', '/sitemap.xml', '/llms.txt'];

/** Every URL a deploy can change: pages, layer pages (built from index.html), data files. */
export function purgeUrls(catalog, origin) {
  const paths = [...PAGES, ...FILES, ...(catalog.layers || []).map((l) => `/view/${l.id}`)];
  return [...new Set(paths)].map((p) => origin + p);
}

export function chunks(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function purge(zone, token, files) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ files }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.success) throw new Error(`HTTP ${r.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`);
}

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const zone = process.env.CF_ZONE_ID;
  if (!token || !zone) {
    console.log('::warning::cache purge skipped: CLOUDFLARE_API_TOKEN or CF_ZONE_ID not set');
    return;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const catalog = JSON.parse(readFileSync(resolve(here, '../../catalog.json'), 'utf8'));
  const batches = chunks(purgeUrls(catalog, 'https://bharatlas.com'), 30);
  let purged = 0;
  for (const [i, batch] of batches.entries()) {
    try {
      await purge(zone, token, batch).catch(() => purge(zone, token, batch)); // one retry
      purged += batch.length;
      console.log(`purged batch ${i + 1}/${batches.length} (${batch.length} URLs)`);
    } catch (e) {
      console.log(`::warning::cache purge batch ${i + 1}/${batches.length} failed: ${e.message}`);
    }
  }
  console.log(`cache purge: ${purged} URLs purged`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
