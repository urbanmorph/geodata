# India admin-boundary extraction — gap report

Date: 2026-05-19
Project root: `~/GitHub/geodata/`

## TL;DR

Pan-India admin polygons from **state → village** are in `sources/`, totalling ~1.6 GB across three independent providers (LGD, SOI, Bhuvan). LGD is the gold standard because it carries the full state→district→block→village code chain. Per-state convenience extracts for CG/JH/OD live under `data/boundaries/<level>/`.

Cross-checked against 63 villages in 30 blocks / 16 districts (CG/JH/OD): 100% match by LGD code at every level. Village polygons: 584,615 pan-India in `LGD_Villages.parquet`.

## Directory layout

```
~/GitHub/geodata/
├── REPORT.md                          # this file
├── scripts/
│   ├── fetch.sh                       # pull all admin parquets from india-geodata
│   └── extract_per_state.py           # slice parquets → per-state geojson
│
├── sources/                           # raw downloads (large, gitignore candidate)
│   ├── india-geodata/                 # github.com/yashveeeeeeer/india-geodata
│   │   ├── LGD_States.parquet            7 MB
│   │   ├── SOI_States.parquet           11 MB
│   │   ├── bhuvan_states.parquet         2 MB
│   │   ├── LGD_Districts.parquet        21 MB
│   │   ├── SOI_Districts.parquet        27 MB
│   │   ├── bhuvan_districts.parquet     35 MB
│   │   ├── LGD_Subdistricts.parquet     63 MB
│   │   ├── SOI_Subdistricts.parquet     54 MB
│   │   ├── LGD_Blocks.parquet           66 MB
│   │   ├── bhuvan_blocks.parquet        93 MB
│   │   ├── PMGSY_Blocks.parquet        121 MB
│   │   ├── LGD_Villages.parquet        474 MB · 584,615 polygons
│   │   └── SOI_VILLAGE_POINT.parquet    26 MB · centroids
│   └── geoboundaries/                 # cross-check
│       └── IND_ADM{1,2,3,4}.geojson   ~310 MB
│
└── data/boundaries/                   # per-state extracts (CG / JH / OD)
    ├── states/        lgd_states_{cg,jh,od}.geojson
    ├── districts/     lgd_districts_{cg,jh,od}.geojson
    ├── subdistricts/  lgd_subdistricts_{cg,jh,od}.geojson
    ├── blocks/        lgd_blocks_{cg,jh,od}.geojson
    └── villages/      lgd_villages_{cg,jh,od}.geojson  (158/126/241 MB)
```

The two large pre-existing files (`LGD_Villages.parquet`, `SOI_VILLAGE_POINT.parquet`) are hardlinks shared with `~/GitHub/village/data/geo/`. No extra disk cost; either path resolves to the same inode.

## What was extracted

### Primary source — yashveeeeeeer/india-geodata (GitHub Releases, CC-BY-4.0)

A curated republication of openly-licensed Indian geospatial data. Each admin level is offered as `.parquet`, `.geojsonl.7z`, and `.pmtiles` from up to three providers (LGD / SOI / Bhuvan), plus PMGSY for blocks.

| Level | Source | Rows | File | Has names? | Has LGD codes? | Has parent chain? |
|---|---|---:|---|---|---|---|
| State | LGD | 36 | `LGD_States.parquet` | yes | yes | n/a |
| State | SOI | 40 | `SOI_States.parquet` | yes | yes | n/a |
| State | Bhuvan | 37 | `bhuvan_states.parquet` | yes | own codes | n/a |
| District | LGD | **785** | `LGD_Districts.parquet` | yes | yes | ↑ state |
| District | SOI | 742 | `SOI_Districts.parquet` | yes | partial | ↑ state |
| District | Bhuvan | 663 | `bhuvan_districts.parquet` | yes | own codes | ↑ state |
| Sub-district | LGD | **6,471** | `LGD_Subdistricts.parquet` | yes | yes | ↑ state+dist |
| Sub-district | SOI | 4,723 | `SOI_Subdistricts.parquet` | yes (tehsil) | partial | ↑ state+dist |
| Block (CD) | LGD | **7,146** | `LGD_Blocks.parquet` | yes | yes (full) | ↑ state+dist |
| Block (CD) | Bhuvan | 6,393 | `bhuvan_blocks.parquet` | yes | own codes | ↑ state+dist |
| Block (CD) | PMGSY | 6,637 | `PMGSY_Blocks.parquet` | **no — IDs only** | yes | ↑ state+dist |
| Village | LGD | **584,615** | `LGD_Villages.parquet` | yes | yes (full) | ↑ state+dist+subdt+block+GP |
| Village (point) | SOI | ~600k | `SOI_VILLAGE_POINT.parquet` | yes | partial | ↑ state+dist+subdt |

LGD layers carry: `state_lgd`, `dist_lgd`, `subdt_lgd`, `block_lgd`, `vil_lgd`, plus 2011 Census codes (`stcode11`, `dtcode11`, …). Bhuvan uses its own codes only.

### Secondary source — geoBoundaries (CC-BY 4.0)

Useful as a cross-check; properties are name-only (no parent linkage). The version pinned in `9469f09` is from 2018–2021, sourced "Pathways Data Pvt. Ltd., lgdirectory.gov.in" — i.e. derived from the same LGD upstream.

| Layer | Rows | Year | Note |
|---|---:|---|---|
| ADM1 (state) | 36 | 2021 | name-only |
| ADM2 (district) | 735 | 2021 | name-only |
| ADM3 (sub-district / block) | 6,824 | 2018 | name-only |
| ADM4 | 7,143 | 2019 | **not village-level** — equivalent to blocks despite the level number |

### Per-state geojson extracts (CG / JH / OD)

LGD-source slices, all admin levels, in `data/boundaries/`. Total ~680 MB across the three states. These are direct-use GeoJSON files; the pan-India authoritative store remains the parquets.

Largest are villages: CG 158 MB · JH 126 MB · OD 241 MB.

## Coverage check (sample — SOTH+BON villages in CG/JH/OD)

Validated against the 63-village reference set from the village dashboard:

| Match | Count | Method |
|---|---:|---|
| Districts found in `LGD_Districts.parquet` | **16 / 16** | by `dist_lgd` |
| Blocks found in `LGD_Blocks.parquet` | **32 / 32** | by `block_lgd` |
| Villages found in `LGD_Villages.parquet` | **63 / 63** | by `vil_lgd` |
| Blocks found in `bhuvan_blocks.parquet` | 28 / 32 | by name (spelling drift on Kusmi, Bakawand, Durgukondal, Lamtaput) |

The 32 block-records-for-30-blocks reflects three different `block_lgd` codes registered for "Nandapur, Koraput" — LGD has historical re-codings; use the latest `block_ver` when joining.

## Gaps and caveats

1. **Panchayats not pulled.** `admin/panchayats` exists (LGD 368 MB compressed, Bhuvan 629 MB, eGramSwaraj 309 MB). Skipped to keep the initial pull lean. Uncomment the line in `scripts/fetch.sh` to add them.

2. **Habitations / settlements not pulled.** Huge files (1+ GB each: Karma Shapes polygons 900 MB, GatiShakti 2.5 GB, ESRI Sentinel-2 built-up 545 MB). Worth a dedicated decision before pulling.

3. **SOI and Bhuvan village polygons not pulled.** Only LGD villages (474 MB) was retained. SOI villages parquet is 602 MB; Bhuvan villages parquet is 792 MB. Useful only when cross-validating polygon disputes — LGD-by-code is the working source.

4. **PMGSY_Blocks has IDs but no names.** Joinable only via a separate PMGSY masterdata CSV (also in the india-geodata releases under `admin/habitations/PMGSY_Masterdata.csv`). Not pulled.

5. **Bhuvan under-counts blocks in several states** vs LGD:
   - Gujarat 181 vs 251 · Karnataka 173 vs 234 · Telangana 443 vs 588 · Assam 185 vs 232
   - Bhuvan's release predates several recent re-divisions. Prefer LGD as the modern authority.

6. **geoBoundaries ADM4 is mislabeled.** Despite the level number, it's not village-level (7,143 features). Use it as a redundant block layer or ignore.

7. **Cross-source name spellings drift.** "Odisha" (LGD) vs "Orissa" (Bhuvan); "Durgukondal" (LGD) vs "Durgkondal" (Bhuvan likely). Always join on LGD codes when possible — never on names.

8. **2011 Census codes vs LGD codes.** Both are present in LGD layers (`stcode11`, `dtcode11`, etc. for Census 2011; `state_lgd`, `dist_lgd`, etc. for current LGD). The codes diverge after every reorganisation. Decide which is authoritative for downstream joins (LGD is current; Census 2011 is stable but stale).

9. **Survey of India (SOI) gold copy not freely available.** SoI Open Data Series shapefiles are gated. The "SOI" files here are community-prepared derivatives from authoritative SoI village-point publications (CC-BY-4.0 per the india-geodata repo).

10. **Polygon precision varies.** LGD polygons are simplified (`MaxSimpTol` field present). For precise area / boundary work prefer SOI; for joins-and-display LGD is sufficient.

## Sources cited

- **india-geodata** — github.com/yashveeeeeeer/india-geodata · CC-BY-4.0 / CC-BY-SA / CC0
- **geoBoundaries** — geoboundaries.org · CC-BY-4.0 · pinned commit `9469f09`
- **LGD** — Local Government Directory, lgdirectory.gov.in (upstream master)
- **SOI** — Survey of India open data series (derivative)
- **Bhuvan** — NRSC/ISRO Bhuvan Panchayat portal (derivative)
- **PMGSY** — Pradhan Mantri Gram Sadak Yojana (Rural Roads), blocks layer

## How to refresh

```bash
# from ~/GitHub/geodata/
bash scripts/fetch.sh                 # pull all admin parquets
python3 scripts/extract_per_state.py  # per-state geojson convenience extracts
```

To add a new state, append to `STATES` in `scripts/extract_per_state.py` (state code is the LGD `State_LGD`, e.g. 27 = Maharashtra). To add panchayats / SOI or Bhuvan villages, uncomment lines in `scripts/fetch.sh`.

## Related

- `~/GitHub/district` — existing state + district visualization (Astro).
- `~/GitHub/village` — village dashboard sourcing the same `LGD_Villages.parquet` (hardlinked).
