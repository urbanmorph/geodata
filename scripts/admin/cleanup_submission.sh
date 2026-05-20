#!/usr/bin/env bash
# Delete community submissions by name pattern.
# Removes the R2 blob AND the D1 row (FK cascades to tokens + ratings).
#
# Usage:
#   scripts/admin/cleanup_submission.sh [--local|--remote] '<name pattern>'
#
# Pattern uses SQL LIKE, so:
#   'Test'         -> exact match
#   'TEST:%'       -> all entries starting with TEST:
#   '%bike lanes%' -> contains "bike lanes" anywhere
#
# Default mode is --local. Use --remote AFTER you've deployed and want to
# clean production data — it talks to the live D1 + R2.

set -euo pipefail

MODE="--local"
PATTERN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --local|--remote) MODE="$1"; shift ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) PATTERN="$1"; shift ;;
  esac
done

if [ -z "$PATTERN" ]; then
  echo "missing name pattern. -h for help."
  exit 1
fi
if [[ "$PATTERN" == *"'"* ]]; then
  echo "pattern may not contain single quotes (basic injection guard)"
  exit 1
fi

cd "$(dirname "$0")/../../web"

# wrangler picks OAuth from ~/Library/Preferences/.wrangler unless this is set
unset CLOUDFLARE_API_TOKEN

echo "looking for submissions matching: $PATTERN  ($MODE)"
ROWS_JSON=$(npx --yes wrangler d1 execute geodata-submissions "$MODE" --json \
  --command "SELECT id, name, r2_key FROM submissions WHERE name LIKE '$PATTERN'" 2>/dev/null)

COUNT=$(node -e 'const j = JSON.parse(process.argv[1]); console.log(j[0].results.length)' "$ROWS_JSON")

if [ "$COUNT" -eq 0 ]; then
  echo "no submissions match. nothing to do."
  exit 0
fi

echo ""
echo "$COUNT submission(s) match:"
node -e '
  const j = JSON.parse(process.argv[1]);
  for (const r of j[0].results) console.log("  " + r.id.padEnd(12) + "  " + r.r2_key.padEnd(60) + '\''  "'\'' + r.name + '\''"'\'');
' "$ROWS_JSON"

echo ""
read -p "delete these and their R2 blobs? [y/N] " -n 1 -r
echo
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
  echo "aborted."
  exit 0
fi

# Delete R2 blobs first — if the D1 delete fires before R2 we orphan blobs.
node -e '
  const j = JSON.parse(process.argv[1]);
  for (const r of j[0].results) console.log(r.r2_key);
' "$ROWS_JSON" | while read -r KEY; do
  [ -z "$KEY" ] && continue
  echo "  r2 del  $KEY"
  npx --yes wrangler r2 object delete "geodata-data/$KEY" "$MODE" 2>&1 | tail -1 || true
done

# Delete D1 rows — FKs cascade to submission_tokens + submission_ratings
echo ""
echo "deleting D1 rows…"
npx --yes wrangler d1 execute geodata-submissions "$MODE" \
  --command "DELETE FROM submissions WHERE name LIKE '$PATTERN'" 2>&1 | tail -3

echo "done."
