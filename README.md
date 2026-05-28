# bharatlas

[![ci](https://github.com/urbanmorph/geodata/actions/workflows/ci.yml/badge.svg)](https://github.com/urbanmorph/geodata/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![v1.0](https://img.shields.io/badge/release-v1.0-brightgreen.svg)](https://github.com/urbanmorph/geodata/releases)
[![uptime](https://img.shields.io/website?url=https%3A%2F%2Fbharatlas.com&label=bharatlas.com)](https://bharatlas.com)
[![Lighthouse: 98+](https://img.shields.io/badge/Lighthouse-98%2B-brightgreen?logo=lighthouse)](https://pagespeed.web.dev/analysis?url=https%3A%2F%2Fbharatlas.com)
[![npm](https://img.shields.io/npm/v/bharatlas-mcp?label=MCP&color=indigo)](https://npmjs.com/package/bharatlas-mcp)

A visual catalog, REST API, MCP server, drag-drop verifier, and anonymous contribution flow for India's geo data. Admin boundaries from state to village, plus community-submitted layers under open licences.

**Live**: https://bharatlas.com

```
catalog               → India national boundary (LGD-dissolved)
                        + state · district · subdistrict · block · village (LGD)
                        + cross-source alternates (SOI · Bhuvan · geoBoundaries
                        · PMGSY per level — click "also: ..." on any card)
                        + city wards across Indian cities
                        + electoral constituencies, wildlife, eco-zones
                        + 63k pincode polygons (bharatviz)
download              → whole layer as Parquet · PMTiles · GeoJSON · KML ·
                        Shapefile, direct from the card
filter & slice        → dynamic facets / range / typeahead search per
                        layer schema; export the slice in any format above
preview               → drop GeoJSON · KML · KMZ · GPX · TCX · Parquet →
                        render + validate → optional Publish
view (/view/<id>)     → curated layer with per-layer OG card
view (/c/<id>)        → community submission, edge-rendered HTML, 👍 useful
                        vote, per-submission OG card
embed                 → /embed/<id> iframe + PNG export from any map
API (/api/v1)         → REST API: list, query, filter, group_by any layer;
                        locate (point-in-polygon across all layers);
                        nearby (tile-based spatial proximity)
MCP (npx bharatlas-mcp) → 8 tools for LLMs: list, schema, query, locate,
                        nearby, categories, submissions, downloads
```

## What's in this repo

| Path | Contents |
|---|---|
| `web/` | Vanilla TypeScript + Vite viewer + Cloudflare Pages Functions (`web/functions/`). |
| `web/migrations/` | D1 SQL migrations: submissions, tokens, ratings, votes, originals. |
| `web/tests/` | vitest unit tests for pure functions (validators, tokens, view rendering, votes). |
| `scripts/fetch.sh` | Pulls parquets + PMTiles from [yashveeeeeeer/india-geodata](https://github.com/yashveeeeeeer/india-geodata) releases. |
| `scripts/extract_per_state.py` | Slices pan-India parquets into per-state GeoJSON via DuckDB-spatial. |
| `scripts/bake_whole_layer.py` | Bakes whole-layer GeoJSON / KML / Shapefile per curated layer (parquet ≤ 100 MB). |
| `scripts/upload_r2.sh` | Mirrors `sources/` + `data/` to Cloudflare R2 via wrangler. |
| `scripts/upload_baked.py` | Pushes `data/baked/*` to R2 via boto3 (S3-compat fallback when wrangler is unavailable). |
| `scripts/admin/cleanup_submission.sh` | Delete community submissions by name pattern (R2 + D1). |
| `mcp/` | MCP server for LLMs ([npm](https://www.npmjs.com/package/bharatlas-mcp)). 8 tools: list, schema, query, locate, nearby, categories, submissions, downloads. |
| `catalog.json` | Curated-layer index used by the viewer. Single source of truth. |
| [/about#caveats](https://bharatlas.com/about#caveats) | Data caveats (cross-source drift, coverage gaps, precision). |

Large data files (`sources/`, `data/`) are not in git — they live in R2. See `scripts/fetch.sh` to rebuild locally.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla TypeScript, Vite, MapLibre GL JS, PMTiles, DuckDB-WASM (lazy) |
| Static hosting | Cloudflare Pages |
| Edge functions | Cloudflare Pages Functions (`web/functions/`) — REST API v1, submit, vote, sitemap, edge-rendered `/c/<id>` |
| Parquet query | [hyparquet](https://github.com/hyparam/hyparquet) (pure JS, runtime reads from R2) |
| Spatial query | PMTiles tile reads + MVT decode + ray-casting PIP / Haversine proximity |
| MCP server | [`bharatlas-mcp`](https://www.npmjs.com/package/bharatlas-mcp) — 8 tools for Claude, GPT, Gemini, Cursor, etc. |
| Storage | Cloudflare R2 (open data, no egress) |
| Submissions DB | Cloudflare D1 (SQLite at the edge) |
| Anti-abuse | Cloudflare Turnstile + per-IP rate limits |
| CI/CD | GitHub Actions — tests + build + auto-deploy on push to `main` |

## Develop

```bash
# clone + viewer-only dev (no submissions, no D1)
git clone git@github.com:urbanmorph/geodata.git
cd geodata/web
npm install
npm run dev    # http://localhost:5173
npm test
```

For the full submission flow (D1 + R2 + Turnstile + Pages Functions), see [docs/full-dev.md](./docs/full-dev.md) (TODO) or read `wrangler.toml` + `.dev.vars.example`.

## Contributing

1. Branch off `main`: `git checkout -b feat/short-name`
2. Write a test first if you're adding logic to `web/functions/lib/*`. Pure functions are tested via vitest in `web/tests/`.
3. Make sure `npm test` and `npm run build` both pass.
4. Open a PR against `main`. CI runs tests + build automatically.
5. The maintainer reviews and merges. Merge to main = auto-deploy.

Commit messages: short subject, body explains *why* not *what*. Examples in `git log`.

## Changelog

See [releases](https://github.com/urbanmorph/geodata/releases) and [merged PRs](https://github.com/urbanmorph/geodata/pulls?q=is%3Amerged).

## Security

Report vulnerabilities to **sathya@urbanmorph.com** instead of opening a public issue. Acknowledgement within 72 hours.

## Licence

Code: [MIT](./LICENSE). Data: each layer carries its own open licence — see the per-card line on the [catalog](https://bharatlas.com/). Curated data is sourced under CC0-1.0 / CC-BY-4.0 / GODL-India depending on provider.

## Use of data

Provided as-is, no warranty. For legal/administrative use, go to the upstream source. Full disclaimers: [/about → Use of data](https://bharatlas.com/about#use-of-data).

## Credits

Data sources, in approximate order of catalog footprint:

- [LGD](https://lgdirectory.gov.in/) — Local Government Directory; the authoritative admin code chain (state → village).
- [SOI](https://surveyofindia.gov.in/) — Survey of India; admin alternatives.
- [Bhuvan](https://bhuvan.nrsc.gov.in/) — NRSC/ISRO Bhuvan; admin alternatives, eco-sensitive zones.
- [OpenCity](https://data.opencity.in/) / [Oorvani Foundation](https://oorvanifoundation.org/) — city-scale layers (ward / corporation / jurisdiction polygons for 20+ cities).
- [DataMeet](https://github.com/datameet/Municipal_Spatial_Data) — community-curated municipal spatial data (ward boundaries for multiple cities).
- [datta07/INDIAN-SHAPEFILES](https://github.com/datta07/INDIAN-SHAPEFILES) — metropolitan city ward shapefiles.
- [PMGSY](https://omms.nic.in/) — Pradhan Mantri Gram Sadak Yojana; rural blocks + roads.
- [PM GatiShakti](https://gis.pmgatishakti.gov.in/) — wildlife sanctuaries + national parks.
- [Bharatmaps](https://bharatmaps.gov.in/) (NIC) — eco-sensitive zones.
- [bharatviz](https://bharatviz.org/) (Saket Choudhary, MIT) — India Post pincode boundary polygons (simplified).
- [geoBoundaries](https://www.geoboundaries.org/) — independent cross-check.
- [data.gov.in](https://data.gov.in/) — additional government open data.

Pipelines + patterns:

- [yashveeeeeeer/india-geodata](https://github.com/yashveeeeeeer/india-geodata) — upstream Parquet + PMTiles re-publisher for LGD, SOI, Bhuvan, PMGSY, GatiShakti, Bharatmaps, CWC, NIC-Health and the India Flood Inventory.
- [ramSeraph/indianopenmaps](https://github.com/ramSeraph/indianopenmaps) — upstream re-publisher for Google Open Buildings, Microsoft Buildings, VEDAS power infrastructure, WRIS waterbodies, SLUSI soil, PMGSY rural roads + habitations and other layers ingested per the v2 candidate-layers plan.
- [mdshare](https://mdshare.dev/) — the anonymous-token contribution pattern lineage.

Built by [Urban Morph](https://urbanmorph.com) · [Sathya Sankaran](https://www.sathyasankaran.com). Drop a ⭐ if you find it useful.

**Status:** v1.0. Curated layers, community submissions, REST API, MCP server ( [npm](https://www.npmjs.com/package/bharatlas-mcp)), dynamic filters with typeahead, whole-layer downloads in 5 formats. API docs at [/docs](https://bharatlas.com/docs), MCP setup at [/mcp](https://bharatlas.com/mcp). Community submissions are permanent under the open licence the contributor selected.
