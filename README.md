# bharatlas

[![ci](https://github.com/urbanmorph/geodata/actions/workflows/ci.yml/badge.svg)](https://github.com/urbanmorph/geodata/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![status: alpha](https://img.shields.io/badge/status-alpha-orange.svg)](#status)

A visual catalog, drag-drop verifier, and anonymous contribution flow for India's geo data. Admin boundaries from state to village, plus community-submitted layers under open licences.

**Live**: https://bharatlas.com

```
catalog               → state · district · subdistrict · block · village (LGD)
                        + city wards (Bengaluru, Chennai, Hyderabad, Mumbai, …)
                        + electoral constituencies, wildlife, eco-zones
preview               → drop GeoJSON · KML · KMZ · GPX · TCX · Parquet →
                        render + validate → optional Publish
filter & export       → dynamic facets / range / search per layer schema,
                        slice by what the data actually contains, export
                        as Parquet · GeoJSON · KML
view (/view/<id>)     → curated layer with per-layer OG card
view (/c/<id>)        → community submission, edge-rendered HTML, ▲/▼ vote,
                        per-submission OG card
embed                 → /embed/<id> iframe + PNG export from any map
```

## What's in this repo

| Path | Contents |
|---|---|
| `web/` | Vanilla TypeScript + Vite viewer + Cloudflare Pages Functions (`web/functions/`). |
| `web/migrations/` | D1 SQL migrations: submissions, tokens, ratings, votes, originals. |
| `web/tests/` | vitest unit tests for pure functions (validators, tokens, view rendering, votes). |
| `scripts/fetch.sh` | Pulls parquets + PMTiles from [yashveeeeeeer/india-geodata](https://github.com/yashveeeeeeer/india-geodata) releases. |
| `scripts/extract_per_state.py` | Slices pan-India parquets into per-state GeoJSON via DuckDB-spatial. |
| `scripts/upload_r2.sh` | Mirrors `sources/` + `data/` to Cloudflare R2. |
| `scripts/admin/cleanup_submission.sh` | Delete community submissions by name pattern (R2 + D1). |
| `catalog.json` | Curated-layer index used by the viewer. Single source of truth. |
| `REPORT.md` | Coverage + provenance + caveats per curated layer. |

Large data files (`sources/`, `data/`) are not in git — they live in R2. See `scripts/fetch.sh` to rebuild locally.

## Stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla TypeScript, Vite, MapLibre GL JS, PMTiles, DuckDB-WASM (lazy) |
| Static hosting | Cloudflare Pages |
| Edge functions | Cloudflare Pages Functions (`web/functions/`) — submit, vote, sitemap, edge-rendered `/c/<id>` |
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
npm test       # 320+ vitest tests
```

For the full submission flow (D1 + R2 + Turnstile + Pages Functions), see [docs/full-dev.md](./docs/full-dev.md) (TODO) or read `wrangler.toml` + `.dev.vars.example`.

## Contributing

1. Branch off `main`: `git checkout -b feat/short-name`
2. Write a test first if you're adding logic to `web/functions/lib/*`. Pure functions are tested via vitest in `web/tests/`.
3. Make sure `npm test` and `npm run build` both pass.
4. Open a PR against `main`. CI runs tests + build automatically.
5. The maintainer reviews and merges. Merge to main = auto-deploy.

Commit messages: short subject, body explains *why* not *what*. Examples in `git log`.

## Roadmap

- **Now**: "Your submissions" panel · CSP re-enable · a11y to 95+ · privacy + ToS
- **Next**: REST API + MCP server + Claude Code plugin (v5)
- **Done**: catalog, in-browser filter & export, anonymous contribution, mixed catalog, votes, embed + PNG, per-layer OG, schema-driven filters, city ward ingest

Track active work in [Issues](https://github.com/urbanmorph/geodata/issues) and [Milestones](https://github.com/urbanmorph/geodata/milestones).

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
- [OpenCity](https://data.opencity.in/) / [Oorvani Foundation](https://oorvanifoundation.org/) — city-scale layers (15 cities of ward / corporation / jurisdiction polygons).
- [PMGSY](https://omms.nic.in/) — Pradhan Mantri Gram Sadak Yojana; rural blocks + roads.
- [PM GatiShakti](https://gis.pmgatishakti.gov.in/) — wildlife sanctuaries + national parks.
- [Bharatmaps](https://bharatmaps.gov.in/) (NIC) — eco-sensitive zones.
- [geoBoundaries](https://www.geoboundaries.org/) — independent cross-check.
- [data.gov.in](https://data.gov.in/) — additional government open data.

Pipelines + patterns:

- [yashveeeeeeer/india-geodata](https://github.com/yashveeeeeeer/india-geodata) — upstream Parquet + PMTiles re-publisher.
- [mdshare](https://mdshare.dev/) — the anonymous-token contribution pattern lineage.

Built by [Urban Morph](https://urbanmorph.com) · [Sathya Sankaran](https://www.sathyasankaran.com). Drop a ⭐ if you find it useful.

**Status:** alpha. Submission flow is live and accepting contributions; the schema and external API may shift before v5. Community submissions are permanent under the open licence the contributor selected.
