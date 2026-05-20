# Curated data — coverage + caveats

Coverage report for bharatlas's curated admin layers. For implementation details (directory layout, refresh commands) see the [README](./README.md). For per-card licence + attribution see the [catalog](https://bharatlas.com/).

Last verified: 2026-05-19.

## TL;DR

Pan-India admin polygons from **state → village** across three providers (LGD, SOI, Bhuvan). LGD is the gold standard because it carries the full state→district→block→village code chain.

Cross-checked against a 63-village reference set across 30 blocks / 16 districts in CG / JH / OD: **100% match by LGD code at every level.**

## What's included

### Primary — yashveeeeeeer/india-geodata (CC-BY-4.0)

A curated republication of openly-licensed Indian geospatial data. Each admin level offered as `.parquet`, `.geojsonl.7z`, and `.pmtiles`.

| Level | Source | Rows | Has names? | Has LGD codes? | Has parent chain? |
|---|---|---:|---|---|---|
| State | LGD | 36 | yes | yes | n/a |
| State | SOI | 40 | yes | yes | n/a |
| State | Bhuvan | 37 | yes | own codes | n/a |
| District | LGD | **785** | yes | yes | ↑ state |
| District | SOI | 742 | yes | partial | ↑ state |
| District | Bhuvan | 663 | yes | own codes | ↑ state |
| Sub-district | LGD | **6,471** | yes | yes | ↑ state+dist |
| Sub-district | SOI | 4,723 | yes (tehsil) | partial | ↑ state+dist |
| Block (CD) | LGD | **7,146** | yes | yes (full) | ↑ state+dist |
| Block (CD) | Bhuvan | 6,393 | yes | own codes | ↑ state+dist |
| Block (CD) | PMGSY | 6,637 | **no — IDs only** | yes | ↑ state+dist |
| Village | LGD | **584,615** | yes | yes (full) | ↑ state+dist+subdt+block+GP |
| Village (point) | SOI | ~600k | yes | partial | ↑ state+dist+subdt |

LGD layers carry: `state_lgd`, `dist_lgd`, `subdt_lgd`, `block_lgd`, `vil_lgd`, plus 2011 Census codes (`stcode11`, `dtcode11`, …). Bhuvan uses its own codes only.

### Secondary — geoBoundaries (CC-BY-4.0)

Independent cross-check; properties are name-only (no parent linkage). Pinned at commit `9469f09`, sourced "Pathways Data Pvt. Ltd., lgdirectory.gov.in" — i.e. derived from the same LGD upstream.

| Layer | Rows | Year | Note |
|---|---:|---|---|
| ADM1 (state) | 36 | 2021 | name-only |
| ADM2 (district) | 735 | 2021 | name-only |
| ADM3 (sub-district / block) | 6,824 | 2018 | name-only |
| ADM4 | 7,143 | 2019 | **mislabelled — not village-level; equivalent to blocks** |

## Coverage QA — SOTH + BON villages in CG / JH / OD

Validated against a 63-village reference set:

| Match | Count | Method |
|---|---:|---|
| Districts found in `LGD_Districts.parquet` | **16 / 16** | by `dist_lgd` |
| Blocks found in `LGD_Blocks.parquet` | **32 / 32** | by `block_lgd` |
| Villages found in `LGD_Villages.parquet` | **63 / 63** | by `vil_lgd` |
| Blocks found in `bhuvan_blocks.parquet` | 28 / 32 | by name (spelling drift on Kusmi, Bakawand, Durgukondal, Lamtaput) |

The 32-block-records-for-30-blocks reflects three different `block_lgd` codes registered for "Nandapur, Koraput" — LGD has historical re-codings; use the latest `block_ver` when joining.

## Known gaps + caveats

1. **Panchayats not pulled.** Available upstream (LGD 368 MB compressed, Bhuvan 629 MB, eGramSwaraj 309 MB). Skipped to keep the initial pull lean.

2. **Habitations / settlements not pulled.** Multi-GB files (Karma Shapes 900 MB, GatiShakti 2.5 GB, ESRI Sentinel-2 built-up 545 MB). Worth a dedicated decision.

3. **SOI and Bhuvan village polygons not pulled.** Only LGD villages (474 MB) retained. SOI villages 602 MB; Bhuvan villages 792 MB. Useful only when cross-validating polygon disputes — LGD-by-code is the working source.

4. **PMGSY_Blocks has IDs but no names.** Joinable only via a separate PMGSY masterdata CSV (`admin/habitations/PMGSY_Masterdata.csv` in india-geodata releases). Not pulled.

5. **Bhuvan under-counts blocks in several states** vs LGD: Gujarat 181 vs 251 · Karnataka 173 vs 234 · Telangana 443 vs 588 · Assam 185 vs 232. Bhuvan's release predates several recent re-divisions. Prefer LGD as the modern authority.

6. **geoBoundaries ADM4 is mislabelled.** Despite the level number, it's block-level (7,143 features). Use as redundant block layer or ignore.

7. **Cross-source name spellings drift.** "Odisha" (LGD) vs "Orissa" (Bhuvan); "Durgukondal" vs "Durgkondal". **Always join on LGD codes — never on names.**

8. **2011 Census codes vs current LGD codes.** Both are present in LGD layers. They diverge after every reorganisation. LGD is current; Census 2011 is stable but stale. Decide which is authoritative for your joins.

9. **Survey of India (SOI) gold copy not freely available.** SoI Open Data Series shapefiles are gated. The "SOI" files here are community-prepared derivatives from authoritative SoI village-point publications (CC-BY-4.0).

10. **Polygon precision varies.** LGD polygons are simplified (`MaxSimpTol` field present). For precise area / boundary work prefer SOI; for joins-and-display LGD is sufficient.

## How to read freshness

Each curated layer's `fetched_at` timestamp appears as the "freshness pill" on the catalog card. Anything past 180 days renders as stale. The pipeline does not auto-refresh; running `scripts/fetch.sh` re-pulls the upstream parquets and updates the catalog.

For corrections or new layers, open an issue at github.com/urbanmorph/geodata or contribute via [/submit](https://bharatlas.com/submit) (community-tier — won't be marked curated until promoted).
