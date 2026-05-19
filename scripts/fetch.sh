#!/bin/bash
# Pull India admin-boundary parquets from yashveeeeeeer/india-geodata
# (https://github.com/yashveeeeeeer/india-geodata, CC-BY-4.0).
# Output lands in sources/india-geodata/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../sources/india-geodata"
mkdir -p "$OUT"
cd "$OUT"

BASE="https://github.com/yashveeeeeeer/india-geodata/releases/download"

PATHS=(
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
  "admin/villages/LGD_Villages.parquet"
  "admin/villages/SOI_VILLAGE_POINT.parquet"
  # uncomment if you need cross-source village polygons (large):
  # "admin/villages/SOI_villages.parquet"          # 602 MB
  # "admin/villages/bhuvan_villages.parquet"       # 792 MB
  # uncomment for panchayats:
  # "admin/panchayats/LGD_panchayats.parquet"      # 368 MB
  # "admin/panchayats/bhuvan_panchayats.parquet"   # 629 MB
)

for p in "${PATHS[@]}"; do
  name=$(basename "$p")
  if [ -f "$name" ] && [ -s "$name" ]; then
    echo "skip $name ($(ls -lh "$name" | awk '{print $5}'))"
    continue
  fi
  echo "fetch $name"
  curl -sL --max-time 600 -o "$name" "$BASE/$p"
  ls -lh "$name" | awk '{print "  size:", $5}'
done
