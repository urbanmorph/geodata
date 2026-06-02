"""Bake a community submission into a curated-grade catalog layer.

A fresh community submission lands as the contributor's raw upload at
community/<id>/<filename> and shows on the home grid as a lightweight card
whose "View on map" opens the drag-drop /preview viewer (generic blue
fills, no Filter & export, no per-category chrome). That viewer looks
nothing like the curated /view/ viewer, so a community layer reads as a
second-class citizen.

This script *graduates* a submission to parity. The bake rules, by format:

  parquet   ALWAYS. The viewer's Filter & export panel range-reads parquet
            via DuckDB-WASM; without it there is no filter affordance. Baked
            through ingest_ramseraph.rebake_flatten_bbox, so it also gets
            flat xmin/ymin/xmax/ymax columns + a Hilbert sort + density-aware
            row groups -> /api/v1/nearby + MCP query parity. That bbox/Hilbert
            work self-gates by size: under 10k features it emits a single row
            group and the sort is a harmless no-op (see row_group_size_for).

  geojson   ALWAYS. map.ts renders pmtiles when present, else geojson, so a
            baked layer needs geojson to draw on /view/. Also a download.

  pmtiles   ONLY when the layer is large enough that shipping raw geojson to
            the browser is the bottleneck (>= PMTILES_MIN_FEATURES features
            or >= PMTILES_MIN_BYTES of geojson). Below that MapLibre renders
            the raw geojson instantly and tiling is pure overhead -- a build
            step plus per-pan range requests for data that fits in one fetch.
            See should_bake_pmtiles().

  kml       ALWAYS (one cheap ogr2ogr pass) so the card's download strip
            matches curated layers (Google Earth / Maps ready).

Then it writes a c_<id> provenance:'community' entry into catalog.json. The
curated viewer is entirely catalog-driven by id -- functions/view/[id].ts
and map.ts openLayer both resolve layers via catalog.layers.find(id) -- so
that single entry makes /view/c_<id> render the community layer with the
IDENTICAL chrome, basemap, Filter & export, and download surface as any
curated layer. prerender then routes the community card's "View on map" to
/view/c_<id> (see web/scripts/community-card.mjs).

Metadata comes from D1 (the submissions table) via wrangler -- the exact
source prerender uses. The raw file comes from R2.

Runbook (airtight: safe to run repeatedly, safe to drive from Claude Code):

  1. Preview first; writes nothing, anywhere:
       python3 scripts/bake_community.py --dry-run <id>
  2. Bake for real; uploads to R2 + patches root catalog.json:
       python3 scripts/bake_community.py <id>           # one submission
       python3 scripts/bake_community.py --all          # every accepted one
  3. Ship the catalog change:
       cd web && npm run build      # prerender copies root catalog.json -> public
       # then commit catalog.json on a branch, open a PR, merge -> CI deploys.

Why it can't break anything:
  - Idempotent. Re-running (or --all) overwrites the same deterministic R2
    keys, replaces the c_<id> catalog entry in place (never duplicates), and
    deletes any orphaned format from a prior larger bake. catalog.json is
    written LAST, so a mid-run failure never leaves a dangling reference;
    just re-run.
  - Rebuild-safe. A full `python3 scripts/build_catalog.py` PRESERVES baked
    community entries via carry_forward_unbuilt() -- they are never silently
    dropped. Pinned by test_build_catalog_community.py.
  - Hand-off rule: never hand-edit a c_<id> entry; re-run the bake instead.

Usage flags:
  --dry-run    bake locally, print the plan + would-be R2 keys, no writes
  --all        bake every status='accepted' submission
  --scope local|remote   which D1 to read metadata from (default: remote)

Requires CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in
env (boto3 -> R2), wrangler authed for D1 (via `wrangler login` or a token
with D1 access), and ogr2ogr + tippecanoe on PATH. If an R2-only
CLOUDFLARE_API_TOKEN is present in the env it shadows oauth for D1; the
script auto-retries the D1 query without it, so a `wrangler login` session
still works without any manual unset.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

# Reuse the canonical bbox/Hilbert rebake + R2 helpers verbatim. This is the
# same module rebake_layer.py builds on; importing it is side-effect free
# (the ingest entry point is guarded by __main__).
from ingest_ramseraph import (  # noqa: E402
    BUCKET, R2_PUBLIC, rebake_flatten_bbox, row_group_size_for,
    r2_client, r2_upload,
)

CATALOG = ROOT / 'catalog.json'
COMMUNITY_PREFIX = 'community'
D1_DATABASE = 'geodata-submissions'

# pmtiles earns its keep only when the raw geojson is too heavy for the
# browser to render directly. Below these, geojson draws instantly and tiles
# are net overhead. ~50k features / ~8 MB is comfortably below where MapLibre
# starts to choke on a single GeoJSON source.
PMTILES_MIN_FEATURES = 50_000
PMTILES_MIN_BYTES = 8 * 1024 * 1024


# ===========================================================================
# Pure decision + shaping helpers (unit-tested in test_bake_community.py)
# ===========================================================================

def should_bake_pmtiles(feature_count: int | None, geojson_bytes: int | None) -> bool:
    return (feature_count or 0) >= PMTILES_MIN_FEATURES or (geojson_bytes or 0) >= PMTILES_MIN_BYTES


@dataclass
class BakePlan:
    parquet: bool
    geojson: bool
    kml: bool
    pmtiles: bool
    row_group_size: int | None


def plan_bakes(feature_count: int | None, geojson_bytes: int | None) -> BakePlan:
    """parquet/geojson/kml are unconditional; pmtiles is size-gated; the
    parquet's row-group size is the same density-aware tier curated layers
    use, so /nearby pruning behaves identically once baked."""
    return BakePlan(
        parquet=True,
        geojson=True,
        kml=True,
        pmtiles=should_bake_pmtiles(feature_count, geojson_bytes),
        row_group_size=row_group_size_for(feature_count or 0),
    )


def catalog_layer_id(submission_id: str) -> str:
    return f'c_{submission_id}'


def baked_key(submission_id: str, fmt: str) -> str:
    ext = 'shp.zip' if fmt == 'shapefile' else fmt
    return f'{COMMUNITY_PREFIX}/{submission_id}/{submission_id}.{ext}'


# Every format the bake can emit. A given run produces a subset (pmtiles is
# size-gated); anything in this set but NOT in the run is a stale orphan.
ALL_BAKED_FORMATS = ('parquet', 'geojson', 'kml', 'pmtiles')


def planned_formats(plan: BakePlan) -> list[str]:
    return [f for f in ALL_BAKED_FORMATS if getattr(plan, f)]


def orphan_keys(submission_id: str, plan: BakePlan) -> list[str]:
    """R2 keys for baked formats this plan does NOT produce -- e.g. a pmtiles
    left over from a prior bake when the layer was larger, now unwarranted
    after an edit shrank it. Deleting these keeps community/<id>/ exactly
    matching the catalog entry, so re-baking (or `--all`) is fully idempotent."""
    planned = set(planned_formats(plan))
    return [baked_key(submission_id, f) for f in ALL_BAKED_FORMATS if f not in planned]


def build_community_catalog_entry(meta: dict, artifacts: dict) -> dict:
    """Build the c_<id> catalog layer from D1 metadata + baked-artifact blocks.

    `artifacts` shape: {fmt: {'url': str, 'bytes': int}} for each format that
    was actually baked. Pure (no I/O) so the entry shape is asserted in tests.
    """
    sub_id = meta['id']
    entry: dict = {
        'id': catalog_layer_id(sub_id),
        'level': None,  # community layers sit outside the admin-level ladder
        'name': meta.get('name') or sub_id,
        'description': meta.get('description') or '',
        'source': 'Community',
        'rows': meta.get('feature_count'),
        'parquet': artifacts.get('parquet'),
        'pmtiles': artifacts.get('pmtiles'),
        'geojson': artifacts.get('geojson'),
        'kml': artifacts.get('kml'),
        'licence': meta.get('license') or '',
        'attribution': {
            'primary': {
                'name': meta.get('attribution') or 'Community contributor',
                'url': meta.get('source_url') or '',
            },
            'publisher': None,
        },
        'category': meta.get('category') or 'other',
        'provenance': 'community',
        'submission_id': sub_id,
        'is_original': bool(meta.get('is_original')),
        'fetched_at': meta.get('created_at'),
    }
    # Drop format blocks that weren't baked so the catalog carries no null keys.
    for fmt in ALL_BAKED_FORMATS:
        if not entry.get(fmt):
            entry.pop(fmt, None)
    return entry


def merge_community_entry(catalog: dict, entry: dict) -> dict:
    """Replace an existing layer with the same id in place (preserving order),
    else append. Mutates and returns `catalog`."""
    layers = catalog.setdefault('layers', [])
    for i, layer in enumerate(layers):
        if layer.get('id') == entry['id']:
            layers[i] = entry
            return catalog
    layers.append(entry)
    return catalog


# ===========================================================================
# D1 + format conversions (I/O)
# ===========================================================================

# submissions columns this bake needs; mirrors prerender's community query.
_SUBMISSION_COLS = (
    'id, name, description, category, license, attribution, source_url, '
    'is_original, format, bytes, feature_count, r2_key, created_at, status'
)


def _wrangler_bin() -> list[str]:
    try:
        subprocess.run(['which', 'wrangler'], check=True, capture_output=True)
        return ['wrangler']
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ['npx', '--yes', 'wrangler']


def _d1_query(sql: str, scope: str) -> list[dict]:
    cmd = [*_wrangler_bin(), 'd1', 'execute', D1_DATABASE, f'--{scope}', '--json', '--command', sql]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 and 'CLOUDFLARE_API_TOKEN' in os.environ:
        # Common local trip-up: the env's CLOUDFLARE_API_TOKEN is R2-scoped and
        # shadows `wrangler login` oauth (which has D1), so D1 fails auth 10000.
        # Retry once without it so oauth handles D1. In CI the token has D1
        # access and the first call already succeeds, so this never fires.
        env = {k: v for k, v in os.environ.items() if k != 'CLOUDFLARE_API_TOKEN'}
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        raise RuntimeError(
            f'wrangler d1 execute failed (exit {proc.returncode}); is wrangler authed '
            f'for --{scope} with D1 access? stderr:\n{(proc.stderr or proc.stdout).strip()}'
        )
    data = json.loads(proc.stdout)
    return data[0].get('results', []) if data else []


def fetch_submission(sub_id: str, scope: str) -> dict:
    rows = _d1_query(
        f"SELECT {_SUBMISSION_COLS} FROM submissions WHERE id='{sub_id}'", scope
    )
    if not rows:
        raise KeyError(f'submission {sub_id!r} not found in D1 ({scope})')
    return rows[0]


def fetch_accepted_submissions(scope: str) -> list[dict]:
    return _d1_query(
        f"SELECT {_SUBMISSION_COLS} FROM submissions WHERE status='accepted' "
        "ORDER BY created_at DESC",
        scope,
    )


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, capture_output=True)


def normalize_to_geojson(raw: Path, fmt: str, out_geojson: Path) -> None:
    """Raw upload -> EPSG:4326 GeoJSON. ogr2ogr handles geojson/json/kml/kmz;
    parquet is read through DuckDB (ogr2ogr's Parquet driver isn't guaranteed
    to be present)."""
    out_geojson.unlink(missing_ok=True)
    if fmt == 'parquet':
        import duckdb
        con = duckdb.connect()
        con.execute('INSTALL spatial; LOAD spatial;')
        cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{raw}')").fetchall()
        geom = next((c[0] for c in cols if c[0] in ('geometry', 'geom', 'wkb_geometry')), 'geometry')
        gtype = next((c[1] for c in cols if c[0] == geom), 'BLOB')
        gexpr = geom if 'GEOMETRY' in gtype else f'ST_GeomFromWKB({geom})'
        con.execute(
            f"COPY (SELECT * EXCLUDE ({geom}), {gexpr} AS geom "
            f"FROM read_parquet('{raw}')) TO '{out_geojson}' "
            f"WITH (FORMAT GDAL, DRIVER 'GeoJSON', SRS 'EPSG:4326')"
        )
        return
    _run(['ogr2ogr', '-f', 'GeoJSON', '-t_srs', 'EPSG:4326', '-skipfailures',
          str(out_geojson), str(raw)])


def geojson_to_parquet(gj: Path, out_parquet: Path) -> int:
    """GeoJSON -> nearby-optimised parquet. ST_Read's geometry column is named
    `geom`; rebake_flatten_bbox keys on a column named `geometry`, so alias it
    before handing off the bbox-flatten + Hilbert-sort pass."""
    import duckdb
    tmp = out_parquet.with_suffix('.raw.parquet')
    con = duckdb.connect()
    con.execute('INSTALL spatial; LOAD spatial;')
    con.execute(
        f"COPY (SELECT * EXCLUDE (geom), geom AS geometry FROM ST_Read('{gj}')) "
        f"TO '{tmp}' (FORMAT PARQUET, COMPRESSION ZSTD)"
    )
    features, _cols = rebake_flatten_bbox(tmp, out_parquet)
    tmp.unlink(missing_ok=True)
    return features


def geojson_to_kml(gj: Path, out_kml: Path) -> None:
    out_kml.unlink(missing_ok=True)
    _run(['ogr2ogr', '-f', 'KML', str(out_kml), str(gj)])


def geojson_to_pmtiles(gj: Path, out_pmtiles: Path, layer_name: str) -> None:
    out_pmtiles.unlink(missing_ok=True)
    _run(['tippecanoe', '-o', str(out_pmtiles), '-l', layer_name, '-zg',
          '--drop-densest-as-needed', '--extend-zooms-if-still-dropping',
          '--force', '--no-progress-indicator', str(gj)])


# ===========================================================================
# Orchestration
# ===========================================================================

def _artifact_block(sub_id: str, fmt: str, path: Path) -> dict:
    return {'url': f'{R2_PUBLIC}/{baked_key(sub_id, fmt)}', 'bytes': path.stat().st_size}


def _delete_orphans(s3, sub_id: str, plan: BakePlan) -> None:
    """Remove stale baked objects from a previous, differently-sized bake so the
    R2 prefix stays a 1:1 mirror of the catalog entry."""
    for key in orphan_keys(sub_id, plan):
        try:
            s3.head_object(Bucket=BUCKET, Key=key)
        except s3.exceptions.ClientError:
            continue  # not present — already clean
        s3.delete_object(Bucket=BUCKET, Key=key)
        print(f'  cleaned orphan s3://{BUCKET}/{key}')


def bake(sub_id: str, scope: str, s3, work: Path, *, dry_run: bool) -> dict:
    meta = fetch_submission(sub_id, scope)
    r2_key = meta.get('r2_key')
    src_fmt = (meta.get('format') or '').lower()
    if not r2_key:
        raise RuntimeError(f'{sub_id}: submission has no r2_key')

    work.mkdir(parents=True, exist_ok=True)
    raw = work / f'_raw_{sub_id}.{src_fmt or "bin"}'
    gj = work / f'{sub_id}.geojson'
    pq = work / f'{sub_id}.parquet'
    kml = work / f'{sub_id}.kml'
    pmt = work / f'{sub_id}.pmtiles'

    print(f'→ {sub_id}  ({meta.get("name")})')
    print(f'  fetching s3://{BUCKET}/{r2_key}')
    s3.download_file(BUCKET, r2_key, str(raw))

    normalize_to_geojson(raw, src_fmt, gj)
    geojson_bytes = gj.stat().st_size
    features = geojson_to_parquet(gj, pq)
    plan = plan_bakes(features, geojson_bytes)
    geojson_to_kml(gj, kml)
    if plan.pmtiles:
        geojson_to_pmtiles(gj, pmt, catalog_layer_id(sub_id))

    print(f'  features: {features:,} · geojson {geojson_bytes:,}B · '
          f'parquet {pq.stat().st_size:,}B · pmtiles={plan.pmtiles} '
          f'(rgs={plan.row_group_size})')

    artifacts = {
        'parquet': _artifact_block(sub_id, 'parquet', pq),
        'geojson': _artifact_block(sub_id, 'geojson', gj),
        'kml': _artifact_block(sub_id, 'kml', kml),
    }
    if plan.pmtiles:
        artifacts['pmtiles'] = _artifact_block(sub_id, 'pmtiles', pmt)

    meta['feature_count'] = features  # authoritative count from the actual bake
    entry = build_community_catalog_entry(meta, artifacts)

    if dry_run:
        print('  [dry-run] would upload:')
        for fmt in artifacts:
            print(f'    s3://{BUCKET}/{baked_key(sub_id, fmt)}')
        orphans = orphan_keys(sub_id, plan)
        if orphans:
            print('  [dry-run] would clean orphans (if present):')
            for key in orphans:
                print(f'    s3://{BUCKET}/{key}')
        print('  [dry-run] catalog entry:')
        print('    ' + json.dumps(entry, ensure_ascii=False))
        return entry

    for fmt, path in (('parquet', pq), ('geojson', gj), ('kml', kml), ('pmtiles', pmt)):
        if fmt in artifacts:
            r2_upload(s3, path, baked_key(sub_id, fmt))
    # Keep the R2 prefix a 1:1 mirror of the catalog entry → fully idempotent.
    _delete_orphans(s3, sub_id, plan)

    catalog = json.loads(CATALOG.read_text())
    merge_community_entry(catalog, entry)
    # Match build_catalog.py's writer exactly (indent=2, default ensure_ascii)
    # so the patch is a clean single-entry diff, not a whole-file re-encode.
    CATALOG.write_text(json.dumps(catalog, indent=2) + '\n')
    print(f'✓ {sub_id}: baked → /view/{entry["id"]} · catalog patched')
    return entry


def main(argv: list[str]) -> int:
    args = argv[1:]
    dry_run = '--dry-run' in args
    scope = 'remote'
    if '--scope' in args:
        i = args.index('--scope')
        scope = args[i + 1]
        del args[i:i + 2]
    do_all = '--all' in args
    ids = [a for a in args if not a.startswith('--')]

    for key in ('CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'):
        if key not in os.environ:
            print(f'ERROR: {key} not set in env')
            return 2
    if not do_all and not ids:
        print(__doc__)
        return 2

    s3 = r2_client()
    work = Path('/tmp/bake_community')
    targets = [s['id'] for s in fetch_accepted_submissions(scope)] if do_all else ids
    if not targets:
        print('no submissions to bake')
        return 0

    for sub_id in targets:
        try:
            bake(sub_id, scope, s3, work / sub_id, dry_run=dry_run)
        except Exception as e:  # noqa: BLE001 — surface which id failed, continue the batch
            print(f'ERROR bake {sub_id}: {e}')
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
