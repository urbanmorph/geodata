#!/bin/bash
# Upload local sources/ and data/ to Cloudflare R2 bucket geodata-data.
#
# This script only maps local files to R2 keys; the upload itself is
# scripts/upload_baked.py --pairs, which goes through pipeline.r2_upload:
# it skips an object whose md5 matches (sizes alone miss a lat,lon swap),
# uploads anything over 64 MB in parts (no 300 MiB wrangler cap), and sets
# Content-Type + Content-Disposition (attachment, except pmtiles).
#
#   scripts/upload_r2.sh           # upload
#   scripts/upload_r2.sh --list    # print "<local path><TAB><key>" pairs, touch nothing
#
# Requires (for upload): CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="${GEODATA_ROOT:-$(cd "$HERE/.." && pwd)}"

level_of() {
  case "$1" in
    LGD_States|SOI_States|bhuvan_states) echo states ;;
    LGD_Districts|SOI_Districts|bhuvan_districts) echo districts ;;
    LGD_Subdistricts|SOI_Subdistricts) echo subdistricts ;;
    LGD_Blocks|bhuvan_blocks|PMGSY_Blocks) echo blocks ;;
    LGD_Villages|SOI_VILLAGE_POINT) echo villages ;;
    *) echo misc ;;
  esac
}

pair() { printf '%s\t%s\n' "$1" "$2"; }

pairs() {
  local f base
  # admin parquets + pmtiles
  for f in "$ROOT"/sources/india-geodata/*.parquet "$ROOT"/sources/india-geodata/*.pmtiles; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    pair "$f" "admin/$(level_of "${base%.*}")/$base"
  done
  # geoboundaries cross-check layers
  for f in "$ROOT"/sources/geoboundaries/*.geojson; do
    [ -e "$f" ] || continue
    pair "$f" "geoboundaries/$(basename "$f")"
  done
  # pre-baked per-state extracts
  for f in "$ROOT"/data/extracts/*/*/*.*; do
    [ -e "$f" ] || continue
    pair "$f" "${f#"$ROOT"/data/}"
  done
  # whole-layer baked downloads: data/baked/<r2-prefix>/<file> -> <r2-prefix>/<file>
  if [ -d "$ROOT/data/baked" ]; then
    find "$ROOT/data/baked" -type f ! -name '*.part.*' | sort | while read -r f; do
      pair "$f" "${f#"$ROOT"/data/baked/}"
    done
  fi
}

if [ "${1:-}" = "--list" ]; then
  pairs
  exit 0
fi

pairs | python3 "$HERE/upload_baked.py" --pairs
