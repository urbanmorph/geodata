# bharatlas

[![ci](https://github.com/urbanmorph/geodata/actions/workflows/ci.yml/badge.svg)](https://github.com/urbanmorph/geodata/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![uptime](https://img.shields.io/website?url=https%3A%2F%2Fbharatlas.com&label=bharatlas.com)](https://bharatlas.com)
[![Lighthouse: 98+](https://img.shields.io/badge/Lighthouse-98%2B-brightgreen?logo=lighthouse)](https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fbharatlas.com)
[![npm](https://img.shields.io/npm/v/bharatlas-mcp?label=MCP&color=indigo)](https://npmjs.com/package/bharatlas-mcp)

A visual catalog, REST API, MCP server, drag-drop verifier, anonymous contribution flow, and a mobile crowd map-capture tool (collect) for India's geo data. Admin boundaries from state to village, plus community-submitted layers under open licences.

**Live**: https://bharatlas.com · collect at https://collect.bharatlas.com

[![bharatlas, India's open atlas](https://bharatlas.com/og-default.png)](https://bharatlas.com)

- **Catalog** – India national boundary (LGD-dissolved), plus state · district · subdistrict · block · village (LGD), cross-source alternates (SOI · Bhuvan · geoBoundaries · PMGSY per level, click "also: ..." on any card), city wards across Indian cities, electoral constituencies, wildlife, eco-zones, and 63k pincode polygons (bharatviz).
- **Download** – whole layer as Parquet · PMTiles · GeoJSON · KML · Shapefile, direct from the card.
- **Filter & slice** – dynamic facets / range / typeahead search per layer schema; export the slice in any format above.
- **Preview** – drop GeoJSON · KML · KMZ · GPX · TCX · Parquet, render + validate, optional Publish.
- **View** (`/view/<id>`) – curated layer with per-layer OG card.
- **Community view** (`/c/<id>`) – community submission, edge-rendered HTML, 👍 useful vote, per-submission OG card.
- **Embed** (`/embed/<id>`) – iframe + PNG export from any map.
- **Collect** ([collect.bharatlas.com](https://collect.bharatlas.com)) – mobile crowd map-capture. Design a small form, share a link, and anyone with it plots points, lines and areas from their phone with no account. Review contributions, then download or publish to the catalog. Token-scoped (view / collect / admin), like [mdshare](https://mdshare.live).
- **API** (`/api/v1`) – REST list, query, filter, group_by any layer; locate (point-in-polygon across all layers); nearby (tile-based spatial proximity). Plus a token-authed collect write API at `collect.bharatlas.com/api/collect/v1`.
- **MCP** (`npx bharatlas-mcp`) – 17 tools for LLMs. Read (list, schema, query, locate, nearby, categories, submissions, downloads) + collect authoring (register a map share link, moderate, import, publish). Also shipped as a Claude Code plugin.

## What's in this repo

- **`web/`** – Vanilla TypeScript + Vite viewer + Cloudflare Pages Functions (`web/functions/`).
- **`collect/`** – the collect crowd map-capture app ([collect.bharatlas.com](https://collect.bharatlas.com)) + its token-authed Pages Functions API (`collect/functions/`). Deploys as a separate Pages project.
- **`web/migrations/`** – D1 SQL migrations: submissions, tokens, ratings, votes, originals.
- **`web/tests/`** – vitest unit tests for pure functions (validators, tokens, view rendering, votes).
- **`scripts/fetch.sh`** – Pulls parquets + PMTiles from [yashveeeeeeer/india-geodata](https://github.com/yashveeeeeeer/india-geodata) releases.
- **`scripts/extract_per_state.py`** – Slices pan-India parquets into per-state GeoJSON via DuckDB-spatial.
- **`scripts/bake_whole_layer.py`** – Bakes whole-layer GeoJSON / KML / Shapefile per curated layer (parquet ≤ 100 MB).
- **`scripts/upload_r2.sh`** – Mirrors `sources/` + `data/` to Cloudflare R2 via wrangler.
- **`scripts/upload_baked.py`** – Pushes `data/baked/*` to R2 via boto3 (S3-compat fallback when wrangler is unavailable).
- **`scripts/admin/cleanup_submission.sh`** – Delete community submissions by name pattern (R2 + D1).
- **`mcp/`** – MCP server for LLMs ([npm](https://www.npmjs.com/package/bharatlas-mcp), [registry](https://registry.modelcontextprotocol.io)). 17 tools: read (list, schema, query, locate, nearby, categories, submissions, downloads) + collect authoring (register_map, get/list records, moderate, import, edit, publish).
- **`plugins/claude-code/`** + **`.claude-plugin/marketplace.json`** – the Claude Code plugin that ships the MCP with auto-updates (`/plugin marketplace add urbanmorph/geodata`).
- **`catalog.json`** – Curated-layer index used by the viewer. Single source of truth.
- **[/about#caveats](https://bharatlas.com/about#caveats)** – Data caveats (cross-source drift, coverage gaps, precision).

Large data files (`sources/`, `data/`) are not in git. They live in R2. See `scripts/fetch.sh` to rebuild locally.

## Stack

- **Frontend** – Vanilla TypeScript, Vite, MapLibre GL JS, PMTiles, DuckDB-WASM (lazy)
- **Static hosting** – Cloudflare Pages
- **Edge functions** – Cloudflare Pages Functions (`web/functions/`), running REST API v1, submit, vote, sitemap, edge-rendered `/c/<id>`
- **Parquet query** – [hyparquet](https://github.com/hyparam/hyparquet) (pure JS, runtime reads from R2)
- **Spatial query** – PMTiles tile reads + MVT decode + ray-casting PIP / Haversine proximity
- **MCP server** – [`bharatlas-mcp`](https://www.npmjs.com/package/bharatlas-mcp), 17 tools (read + collect authoring) for Claude, GPT, Gemini, Cursor, etc.; also a Claude Code plugin
- **Storage** – Cloudflare R2 (open data, no egress)
- **Submissions DB** – Cloudflare D1 (SQLite at the edge)
- **Anti-abuse** – Cloudflare Turnstile + per-IP rate limits
- **CI/CD** – GitHub Actions, running tests + build + auto-deploy on push to `main`

## Develop

```bash
# clone + viewer-only dev (no submissions, no D1)
git clone git@github.com:urbanmorph/geodata.git
cd geodata/web
npm install
npm run dev    # http://localhost:5173
npm test
```

For the full submission flow (D1 + R2 + Turnstile + Pages Functions), read `wrangler.toml` + `.dev.vars.example`.

## API in 30 seconds

REST: `https://bharatlas.com/api/v1` (no API key, rate-limited per IP). Full docs at [bharatlas.com/docs](https://bharatlas.com/docs).

```bash
# list every catalog layer (curated + accepted community)
curl 'https://bharatlas.com/api/v1/layers'

# inspect a layer's schema before querying
curl 'https://bharatlas.com/api/v1/layers/lgd_districts/schema'

# filter + group: how many districts per state?
curl 'https://bharatlas.com/api/v1/layers/lgd_districts/query?group_by=stname'

# point-in-polygon: every admin boundary at (lat, lng)
curl 'https://bharatlas.com/api/v1/locate?lat=12.9716&lng=77.5946'

# nearest features within a radius
curl 'https://bharatlas.com/api/v1/nearby?lat=12.9716&lng=77.5946&layer=nic_health&radius_km=10'
```

MCP for LLMs (Claude, GPT, Gemini, Cursor): one-line install, 17 tools (read + collect authoring). Setup at [bharatlas.com/mcp](https://bharatlas.com/mcp). Read tools need no auth; collect authoring acts only on maps whose share link you register.

```bash
# Claude Code (as a plugin, auto-updates)
/plugin marketplace add urbanmorph/geodata
/plugin install bharatlas@bharatlas

# Claude Code (as a plain MCP server)
claude mcp add bharatlas npx bharatlas-mcp

# Claude Desktop / other clients (claude_desktop_config.json)
{ "mcpServers": { "bharatlas": { "command": "npx", "args": ["bharatlas-mcp"] } } }
```

## Contributing

1. Branch off `main`: `git checkout -b feat/short-name`
2. Write a test first if you're adding logic to `web/functions/lib/*`. Pure functions are tested via vitest in `web/tests/`.
3. Make sure `npm test` and `npm run build` both pass.
4. Open a PR against `main`. CI runs tests + build automatically.
5. The maintainer reviews and merges. Merge to main = auto-deploy.

Commit messages: short subject, body explains *why* not *what*. Examples in `git log`.

## Security

Report vulnerabilities to **sathya@urbanmorph.com** instead of opening a public issue. Acknowledgement within 72 hours.

## Licence

Code: [MIT](./LICENSE). Data: each layer carries its own open licence. See the per-card line on the [catalog](https://bharatlas.com/). Curated data is sourced under CC0-1.0 / CC-BY-4.0 / GODL-India depending on provider.

## Use of data

Provided as-is, no warranty. For legal/administrative use, go to the upstream source. Full disclaimers: [/about → Use of data](https://bharatlas.com/about#use-of-data).

## Principles

bharatlas is built on [People's Digital Goods and Infrastructure (PDGI)](https://pdgi.org/) principles. [PDGI.md](./PDGI.md) is a public, honest scorecard of how each one is implemented, and where we still fall short.

## Credits

Data sources, in approximate order of catalog footprint:

- [LGD](https://lgdirectory.gov.in/) – Local Government Directory; the authoritative admin code chain (state → village).
- [SOI](https://surveyofindia.gov.in/) – Survey of India; admin alternatives.
- [Bhuvan](https://bhuvan.nrsc.gov.in/) – NRSC/ISRO Bhuvan; admin alternatives, eco-sensitive zones.
- [OpenCity](https://data.opencity.in/) / [Oorvani Foundation](https://oorvanifoundation.org/) – city-scale layers (ward / corporation / jurisdiction polygons for 20+ cities).
- [DataMeet](https://github.com/datameet/Municipal_Spatial_Data) – community-curated municipal spatial data (ward boundaries for multiple cities).
- [datta07/INDIAN-SHAPEFILES](https://github.com/datta07/INDIAN-SHAPEFILES) – metropolitan city ward shapefiles.
- [ramSeraph/indianopenmaps](https://github.com/ramSeraph/indianopenmaps) – selectively republished layers (WRIS waterbodies, SLUSI watersheds + soil, VEDAS power infrastructure, PMGSY roads + habitations).
- [CoRE Stack](https://core-stack.org/) – republished water and agriculture layers, namely CGWB aquifers and groundwater extraction, WRIS canals, ICAR-NBSS agro-ecological zones, Planning Commission agro-climatic zones, and Wildlife Institute of India biogeographic zones.
- [PMGSY](https://omms.nic.in/) – Pradhan Mantri Gram Sadak Yojana; rural blocks + roads.
- [PM GatiShakti](https://gis.pmgatishakti.gov.in/) – wildlife sanctuaries + national parks.
- [Bharatmaps](https://bharatmaps.gov.in/) (NIC) – eco-sensitive zones.
- [bharatviz](https://bharatviz.org/) (Saket Choudhary, MIT) – India Post pincode boundary polygons (simplified).
- [geoBoundaries](https://www.geoboundaries.org/) – independent cross-check.
- [data.gov.in](https://data.gov.in/) – additional government open data.

Pipelines + patterns:

- [yashveeeeeeer/india-geodata](https://github.com/yashveeeeeeer/india-geodata) – upstream Parquet + PMTiles re-publisher for LGD, SOI, Bhuvan, PMGSY, GatiShakti, Bharatmaps, CWC, NIC-Health and the India Flood Inventory.
- [ramSeraph](https://github.com/ramSeraph) – architectural guidance on geoparquet for spatial queries ([issue #100](https://github.com/urbanmorph/geodata/issues/100)). Hilbert sort + flat bbox cols + density-aware row groups in our /api/v1/nearby came directly from this review.
- [mdshare](https://mdshare.dev/) – the anonymous-token contribution pattern lineage.

Built by [Urban Morph](https://urbanmorph.com) · [Sathya Sankaran](https://www.sathyasankaran.com). Drop a ⭐ if you find it useful.

**Status:** live and maintained. Curated layers, community submissions, the **collect** crowd map-capture tool, a REST API, an MCP server (17 tools, read + collect authoring; [npm](https://www.npmjs.com/package/bharatlas-mcp), [MCP registry](https://registry.modelcontextprotocol.io), and a Claude Code plugin), dynamic filters with typeahead, and whole-layer downloads in 5 formats. API docs at [/docs](https://bharatlas.com/docs), MCP setup at [/mcp](https://bharatlas.com/mcp). Community submissions are permanent under the open licence the contributor selected.
