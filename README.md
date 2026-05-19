# geodata

Lightweight, open-source visualiser for India admin boundaries — state, district, sub-district, block, village. Pick a layer, view it on a map, download the parquet.

**Live**: https://geodata.pages.dev (soon)

## What's in this repo

| Path | Contents |
|---|---|
| `web/` | Vanilla TypeScript + Vite viewer. Static, hosted on Cloudflare Pages. |
| `scripts/fetch.sh` | Pulls parquets + PMTiles from [yashveeeeeeer/india-geodata](https://github.com/yashveeeeeeer/india-geodata) releases. |
| `scripts/extract_per_state.py` | Slices pan-India parquets into per-state GeoJSON via DuckDB-spatial. |
| `scripts/upload_r2.sh` | Mirrors `sources/` + `data/` to the Cloudflare R2 bucket. |
| `catalog.json` | Dataset index used by the viewer. Single source of truth. |
| `REPORT.md` | Coverage report + provenance + caveats for every layer. |

Large data files (`sources/`, `data/`) are **not in git** — they live in R2 (`geodata-data` bucket, urbanmorph account). See `scripts/fetch.sh` to rebuild locally.

## Layers

13 admin layers across three providers — LGD (authoritative), SOI, Bhuvan — plus geoBoundaries as a cross-check. Full provenance and caveats in [REPORT.md](./REPORT.md).

LGD codes are the join key. Never join on names.

## Stack

- **Frontend**: vanilla TypeScript, Vite, MapLibre GL JS, PMTiles. Zero framework runtime.
- **Storage**: Cloudflare R2 for parquets + PMTiles. Zero egress fees.
- **Hosting**: Cloudflare Pages (static).
- **Data pipeline**: DuckDB + `spatial` extension.

## Develop

```bash
# pull data (large — ~1.3 GB)
bash scripts/fetch.sh

# per-state geojson extracts (optional)
python3 scripts/extract_per_state.py

# viewer
cd web && npm install && npm run dev
```

## Deploy

```bash
cd web && npm run build
wrangler pages deploy ./dist --project-name=geodata
```

## Roadmap

- [x] v1 — viewer + parquet downloads
- [ ] v2 — in-browser slicing (DuckDB-WASM): filter by bbox / polygon, export
- [ ] v3 — user submissions: drag-drop verify (client-only) + submit for inclusion (moderated)
- [ ] v4 — side-by-side LGD vs SOI vs Bhuvan compare

## Licence

Code: MIT. Data: see each layer's `licence` field in `catalog.json` (LGD upstream is CC-BY-4.0).

## Credits

- [yashveeeeeeer/india-geodata](https://github.com/yashveeeeeeer/india-geodata) — upstream parquet + PMTiles publisher
- [LGD](https://lgdirectory.gov.in/), [SOI](https://surveyofindia.gov.in/), [Bhuvan](https://bhuvan.nrsc.gov.in/) — primary sources
- [geoBoundaries](https://www.geoboundaries.org/) — cross-check
