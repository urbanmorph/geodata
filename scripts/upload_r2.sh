#!/bin/bash
# Upload local sources/ and data/ to Cloudflare R2 bucket geodata-data.
# Idempotent: skips objects already on R2 at the same size.
#
# Requires: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID in env.
# Node v22 (wrangler) is picked up from mise.
set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUCKET="geodata-data"
REMOTE_LIST="/tmp/geodata-r2-remote.tsv"

if command -v mise >/dev/null 2>&1; then
  export PATH="$HOME/.local/share/mise/installs/node/22.22.0/bin:$PATH"
fi
node --version | grep -qE '^v(2[0-9]|[3-9][0-9])' || { echo "need node >= 20"; exit 1; }

# Prefer the already-installed wrangler on PATH (mise / homebrew / pnpm)
# over `npx wrangler@latest`, which has hit a workerd arch mismatch on
# this machine where the npx cache resolves the wrong platform binary.
WRANGLER="${WRANGLER_BIN:-wrangler}"

: "${CLOUDFLARE_API_TOKEN:?must be set}"
: "${CLOUDFLARE_ACCOUNT_ID:?must be set}"

# --- list existing remote objects once into a TSV (key<TAB>size) ---
echo "→ listing remote keys in $BUCKET ..."
: > "$REMOTE_LIST"
cursor=""
while :; do
  q="?per_page=1000"
  [ -n "$cursor" ] && q="$q&cursor=$cursor"
  resp=$(curl -sf -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$BUCKET/objects$q")
  cursor=$(echo "$resp" | python3 -c "
import sys, json
d=json.load(sys.stdin)
with open('$REMOTE_LIST', 'a') as f:
    for o in d.get('result', []) or []:
        f.write(f\"{o['key']}\t{o['size']}\n\")
print((d.get('result_info', {}) or {}).get('cursor') or '')
")
  [ -z "$cursor" ] && break
done
echo "  found $(wc -l < "$REMOTE_LIST" | tr -d ' ') existing objects"

remote_size_of() {
  awk -F'\t' -v k="$1" '$1==k {print $2; exit}' "$REMOTE_LIST"
}

WRANGLER_CAP=$((300 * 1024 * 1024))  # 300 MiB

# Cross-origin links to pub-*.r2.dev ignore the HTML `download` attribute,
# so we set Content-Disposition: attachment + a sensible Content-Type on
# every upload. PMTiles is the exception — MapLibre fetches it via Range
# from the browser, attachment would break the renderer.
content_type_for() {
  case "$1" in
    *.parquet) echo 'application/vnd.apache.parquet' ;;
    *.geojson) echo 'application/geo+json' ;;
    *.kml)     echo 'application/vnd.google-earth.kml+xml' ;;
    *.kmz)     echo 'application/vnd.google-earth.kmz' ;;
    *.pmtiles) echo 'application/vnd.pmtiles' ;;
    *.json)    echo 'application/json' ;;
    *.zip)     echo 'application/zip' ;;
    *)         echo 'application/octet-stream' ;;
  esac
}

put() {
  local local_path="$1" remote_key="$2"
  [ -f "$local_path" ] || { echo "  miss $local_path — skip"; return; }
  local local_size remote_size
  local_size=$(stat -f %z "$local_path" 2>/dev/null || stat -c %s "$local_path")
  remote_size=$(remote_size_of "$remote_key")
  if [ "$local_size" = "$remote_size" ]; then
    printf "  skip %-60s (%s bytes, on R2)\n" "$remote_key" "$local_size"
    return
  fi
  if [ "$local_size" -gt "$WRANGLER_CAP" ]; then
    printf "  >300MiB %-57s (%s bytes — use upload_r2_multipart.py)\n" "$remote_key" "$local_size"
    return
  fi
  printf "  put  %-60s (%s bytes)\n" "$remote_key" "$local_size"
  local ct fname disp_flag
  ct=$(content_type_for "$remote_key")
  fname=$(basename "$remote_key")
  disp_flag=""
  case "$remote_key" in
    *.pmtiles) : ;;
    *)         disp_flag="--content-disposition=attachment; filename=\"$fname\"" ;;
  esac
  $WRANGLER r2 object put "$BUCKET/$remote_key" --file="$local_path" --remote \
    --content-type="$ct" $disp_flag >/dev/null || \
    printf "  FAIL %-60s\n" "$remote_key"
}

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

SRC="$ROOT/sources/india-geodata"
echo "→ uploading admin parquets + pmtiles"
for f in "$SRC"/*.parquet "$SRC"/*.pmtiles; do
  [ -e "$f" ] || continue
  base=$(basename "$f")
  stem="${base%.*}"
  lvl=$(level_of "$stem")
  put "$f" "admin/$lvl/$base"
done

echo "→ uploading geoboundaries cross-check layers"
for f in "$ROOT"/sources/geoboundaries/*.geojson; do
  [ -e "$f" ] || continue
  put "$f" "geoboundaries/$(basename "$f")"
done

echo "→ uploading per-state geojson extracts (legacy CG/JH/OD)"
for f in "$ROOT"/data/boundaries/*/*.geojson; do
  [ -e "$f" ] || continue
  rel="${f#$ROOT/data/}"
  put "$f" "$rel"
done

echo "→ uploading pre-baked per-state extracts (all 36 states × 4 levels × 3 formats)"
for f in "$ROOT"/data/extracts/*/*/*.*; do
  [ -e "$f" ] || continue
  # local: data/extracts/<level>/<NN>/<level>_<abbr>.<fmt>
  # remote: extracts/<level>/<NN>/<level>_<abbr>.<fmt>
  rel="${f#$ROOT/data/}"
  put "$f" "$rel"
done

echo "→ uploading whole-layer baked downloads (geojson/kml/shp.zip from bake_whole_layer.py)"
if [ -d "$ROOT/data/baked" ]; then
  # Mirrors the directory tree: data/baked/<r2-prefix>/<file> → <r2-prefix>/<file>
  find "$ROOT/data/baked" -type f | while read -r f; do
    rel="${f#$ROOT/data/baked/}"
    put "$f" "$rel"
  done
else
  echo "  (no data/baked tree yet — run scripts/bake_whole_layer.py first)"
fi

echo "✓ done"
echo "public base: https://pub-0429b8e3b5a946e69ea007df844a6f1c.r2.dev"
