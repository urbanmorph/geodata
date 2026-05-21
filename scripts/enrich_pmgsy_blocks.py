#!/usr/bin/env python3
"""
PMGSY_Blocks ships with BLOCK_ID / STATE_ID / DISTRICT_I (truncated) + geometry,
but no names — REPORT.md item #4. PMGSY_Masterdata.csv provides BLOCK_NAME,
DISTRICT_NAME, STATE_NAME keyed by BLOCK_ID.

This script LEFT JOINs masterdata into the parquet so PMGSY_Blocks becomes
joinable on names, not just IDs. Rewrites PMGSY_Blocks.parquet in place.

Idempotent — re-running just re-joins (same BLOCK_NAME column overwritten).

Run after scripts/fetch.sh (which now also pulls PMGSY_Masterdata.csv).
"""
from pathlib import Path
import sys
import duckdb

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'sources' / 'india-geodata'
PARQUET = SRC / 'PMGSY_Blocks.parquet'
CSV = SRC / 'PMGSY_Masterdata.csv'

if not PARQUET.exists():
    sys.exit(f"missing {PARQUET} — run scripts/fetch.sh first")
if not CSV.exists():
    sys.exit(f"missing {CSV} — run scripts/fetch.sh first")

con = duckdb.connect()
con.execute("INSTALL spatial; LOAD spatial")

# Sanity: how many blocks have masterdata coverage?
total = con.execute(f"SELECT COUNT(*) FROM '{PARQUET}'").fetchone()[0]
matched = con.execute(f"""
    SELECT COUNT(*) FROM '{PARQUET}' b
    INNER JOIN '{CSV}' m ON b.BLOCK_ID = m.BLOCK_ID
""").fetchone()[0]
print(f"  blocks: {total} · masterdata matches: {matched} ({100*matched//total}%)")

# Write to temp, then atomic rename.
TMP = PARQUET.with_suffix('.parquet.enriched')
con.execute(f"""
    COPY (
      SELECT
        b.BLOCK_ID,
        b.STATE_ID,
        b.DISTRICT_I AS DISTRICT_ID,
        m.STATE_NAME,
        m.DISTRICT_NAME,
        m.BLOCK_NAME,
        b.geometry
      FROM '{PARQUET}' b
      LEFT JOIN '{CSV}' m ON b.BLOCK_ID = m.BLOCK_ID
    ) TO '{TMP}' (FORMAT 'parquet', COMPRESSION 'zstd')
""")

# Atomic swap.
TMP.replace(PARQUET)
new_size = PARQUET.stat().st_size
print(f"  wrote {PARQUET.name} ({new_size:,} bytes)")
