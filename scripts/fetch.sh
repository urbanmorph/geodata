#!/bin/bash
# Pull India admin-boundary parquets and PMTiles from yashveeeeeeer/india-geodata
# (https://github.com/yashveeeeeeer/india-geodata, CC-BY-4.0).
# All files dropped flat into sources/india-geodata/ for compatibility with
# scripts/extract_per_state.py.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../sources/india-geodata"
mkdir -p "$OUT"
cd "$OUT"

BASE="https://github.com/yashveeeeeeer/india-geodata/releases/download"

# Each entry is the upstream release path; we save the basename locally.
PATHS=(
  # Parquets (canonical, downloadable)
  "admin/states/LGD_States.parquet"
  "admin/states/SOI_States.parquet"
  "admin/states/bhuvan_states.parquet"
  "admin/districts/LGD_Districts.parquet"
  "admin/districts/SOI_Districts.parquet"
  "admin/districts/bhuvan_districts.parquet"
  "admin/subdistricts/LGD_Subdistricts.parquet"
  "admin/subdistricts/SOI_Subdistricts.parquet"
  "admin/blocks/LGD_Blocks.parquet"
  "admin/blocks/bhuvan_blocks.parquet"
  "admin/blocks/PMGSY_Blocks.parquet"
  "admin/habitations/PMGSY_Masterdata.csv"
  "admin/panchayats/LGD_panchayats.parquet"
  "admin/villages/LGD_Villages.parquet"
  "admin/villages/SOI_VILLAGE_POINT.parquet"

  # PMTiles (vector tiles for the viewer)
  "admin/states/LGD_States.pmtiles"
  "admin/districts/LGD_Districts.pmtiles"
  "admin/subdistricts/LGD_Subdistricts.pmtiles"
  "admin/blocks/LGD_Blocks.pmtiles"
  "admin/panchayats/LGD_Panchayats.pmtiles"
  "admin/villages/LGD_Villages.pmtiles"

  # large optional:
  # "admin/villages/SOI_villages.parquet"          # 602 MB
  # "admin/villages/bhuvan_villages.parquet"       # 792 MB
  # "admin/panchayats/bhuvan_panchayats.parquet"   # 629 MB — 2nd source for panchayats; LGD is authoritative
)

for p in "${PATHS[@]}"; do
  name=$(basename "$p")
  if [ -f "$name" ] && [ -s "$name" ]; then
    echo "skip $name ($(ls -lh "$name" | awk '{print $5}'))"
    continue
  fi
  echo "fetch $name"
  curl -sL --max-time 1200 -o "$name.tmp" "$BASE/$p" && mv "$name.tmp" "$name"
  ls -lh "$name" | awk '{print "  size:", $5}'
done
