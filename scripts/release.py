#!/usr/bin/env python3
"""
Cut a bharatlas release: a dataset's files under a code that never changes or gets reused,
`bharatlas-<dataset>-<year>.<month>` (e.g. bharatlas-cw-2026.11), dated by the day it is cut.

Numbering follows the schemes register (schemes-register-2026.11): <n> is the two-digit month, so a code says
when it was cut, sorts in order, and allows one release of a dataset per month. A second cut in the same month
with different bytes is refused; the correction goes in the next month's release.

Where a release lives:
  web/public/releases/<code>/manifest.json, CHANGES.md, SHA256SUMS   committed; served by Pages
  data/baked/releases/<code>/<files>                                 staged for R2 (key releases/<code>/<file>)
  https://bharatlas.com/releases/<code>/<file>                        the address, redirected to R2
  web/public/releases/index.json                                     every release, newest first

The release SHA-256 is the SHA-256 of its SHA256SUMS file (one "<sha256>  <file>" line per file, sorted), so
`sha256sum -c SHA256SUMS` checks the files and `sha256sum SHA256SUMS` gives the release digest; it is written
with the code as the pin, `<code>+sha256:<hex>`.

Idempotent: the same files under an existing code change nothing (a lost staged copy is restored). Different
files under an existing code are refused (exit 1). No Zenodo and no DOI (deferred): the code, the checksum and
bharatlas.com are the citation; the manifest names the w3id.org address the code will resolve through once it is
registered.

Upload (--upload, R2 creds in the env: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY): each
cut release's files go to R2 at releases/<code>/<file> by pipeline.r2_upload_retrying (resumable multipart, so a
multi-GB file survives a dropped link or a kill; md5 in metadata, attachment Content-Disposition, immutable
Cache-Control; under the host-wide upload lock), new_only: a key that already holds other bytes is refused, never
overwritten. Each file is then checked on R2 (size and md5). Without --upload nothing is uploaded and the keys are
printed: re-run the same command with --upload (the cut itself is idempotent; files already on R2 are skipped).

A layer's release (--layer <id>): the dataset code is the layer id, and the files are the layer's parquet and its
downloads (GeoJSON, KML, Shapefile; never its map tiles), fetched from the URLs catalog.json names, renamed
<id>.<ext>, pinned by SHA-256. The manifest names the layer's source, licence and the URL each file came from (so
r2_prune.py treats those keys as pinned), and CHANGES.md diffs it against the layer's previous release: row count,
columns added, removed or retyped, and the ids added and removed where the layer has a stable id column (unique and
never empty in both versions). --dry-run cuts it into a temporary copy of the releases and prints the manifest,
CHANGES.md and the R2 commands, writing nothing under web/public/releases/.

Usage:
    python3 scripts/release.py data/release-staging/cw [--date 2026-11-15]
    python3 scripts/release.py --layer lgd_states [--dry-run] [--date 2026-12-01]
    python3 -u scripts/release.py --layer lgd_states --upload            # cut (or keep) and upload to R2
    python3 scripts/release.py --index-only
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
META_ROOT = ROOT / 'web' / 'public' / 'releases'
FILES_ROOT = ROOT / 'data' / 'baked' / 'releases'
STAGING_ROOT = ROOT / 'data' / 'release-staging'
CATALOG = ROOT / 'catalog.json'
SITE = 'https://bharatlas.com'
W3ID = 'https://w3id.org/bharatlas/'           # proposed; not registered yet
APP = 'bharatlas'
BUCKET = 'geodata-data'
META_FILE = 'release-meta.json'
_CODE = re.compile(r'^bharatlas-([a-z0-9_]+)-(\d{4})\.(\d{2})$')
# a layer's release files: catalog format -> file extension (map tiles are rebuilt from the parquet, never released)
LAYER_FORMATS = {'parquet': 'parquet', 'geojson': 'geojson', 'kml': 'kml', 'shapefile': 'shp.zip'}
# a source's own id: id, *_id, id_*, *_no, *number*, *code*, *lgd*; never a row number GDAL or a bake added
_ID_NAME = re.compile(r'(?i)(^id$|_id$|^id_|_no$|^no$|number|code|lgd)')
_ROW_NUMBER = re.compile(r'(?i)^(ogc_fid|fid|objectid|rowid|index|__index_level_0__)$')
FILE_INFO = ('rows', 'licence', 'source_layer', 'source_url', 'columns')
MAX_IDS_LISTED = 50


class ReleaseChanged(Exception):
    """A release's files differ from what was cut under that code."""


def release_code(dataset: str, day: str) -> str:
    if not re.fullmatch(r'[a-z0-9_]+', dataset):
        raise ValueError(f'dataset must be lower-case letters, digits or _: {dataset!r}')
    year, month = day.split('-')[:2]
    return f'{APP}-{dataset}-{int(year):04d}.{int(month):02d}'


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha_file(path: Path) -> str:
    """SHA-256 of a file read in 1 MB chunks (release files can be several GB)."""
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding='utf-8') == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8', newline='')
    return True


def _codes(meta_root: Path, dataset: str | None = None) -> list[str]:
    if not meta_root.is_dir():
        return []
    out = [d.name for d in meta_root.iterdir() if _CODE.match(d.name) and (d / 'manifest.json').is_file()]
    if dataset:
        out = [c for c in out if _CODE.match(c).group(1) == dataset]
    return sorted(out, key=lambda c: (_CODE.match(c).group(2, 3), c), reverse=True)


def _manifest(meta_root: Path, code: str) -> dict:
    return json.loads((meta_root / code / 'manifest.json').read_text(encoding='utf-8'))


def previous_release(meta_root: Path, dataset: str, code: str) -> str | None:
    """The dataset's newest release before `code`."""
    earlier = [c for c in _codes(meta_root, dataset) if c < code]
    return earlier[0] if earlier else None


def _citation(meta: dict, code: str, digest: str) -> str:
    sources = '; '.join(s['name'] for s in meta['sources'])
    return (f'{sources}. {meta["title"]}, as released by bharatlas: {code} '
            f'(sha256:{digest}). {SITE}/releases/{code}/')


def _changes(code: str, meta: dict, files: list[dict], previous: str | None, prev_manifest: dict | None,
             digest: str, day: str) -> str:
    lines = [f'# {code}', '', f'{meta["title"]}, cut on {day}.', '']
    if not previous:
        lines += ['The first release under a release code.', '']
        lines += [f'- {f["name"]}: {f["rows"]:,} rows' if f.get('rows') is not None else f'- {f["name"]}'
                  for f in files]
    else:
        before = {f['name']: f for f in prev_manifest.get('files', [])}
        now = {f['name']: f for f in files}
        lines.append(f'Changes since {previous}:')
        lines.append('')
        diffs = []
        for name in sorted(set(before) | set(now)):
            a, b = before.get(name), now.get(name)
            if not a:
                diffs.append(f'- {name}: added ({b.get("rows")} rows)')
            elif not b:
                diffs.append(f'- {name}: removed')
            elif a['sha256'] != b['sha256']:
                diffs.append(f'- {name}: {a.get("rows")} rows to {b.get("rows")}' if a.get('rows') != b.get('rows')
                             else f'- {name}: changed, same row count ({b.get("rows")})')
        lines += diffs or ['- no file changed']
    if meta.get('changes'):
        lines += [''] + meta['changes']
    lines += ['', f'Release SHA-256 (of SHA256SUMS): `{digest}`', '',
              f'Pin: `{code}+sha256:{digest}`', '']
    return '\n'.join(lines)


def make_release(src: Path, day: str, meta_root: Path = META_ROOT, files_root: Path = FILES_ROOT) -> tuple[str, bool]:
    """Cut the release of the staging folder `src`. Returns (code, made); made is False when that code already
    holds these exact files. Raises ReleaseChanged when it holds others."""
    src = Path(src)
    meta = json.loads((src / META_FILE).read_text(encoding='utf-8'))
    code = release_code(meta['dataset'], day)
    names = sorted(p.name for p in src.iterdir() if p.is_file() and p.name != META_FILE)
    shas = {n: _sha_file(src / n) for n in names}
    sums = ''.join(f'{shas[n]}  {n}\n' for n in names)
    digest = _sha(sums.encode('utf-8'))
    meta_dir, files_dir = meta_root / code, files_root / code

    if (meta_dir / 'manifest.json').is_file():
        held = _manifest(meta_root, code)['sha256']
        if held != digest:
            raise ReleaseChanged(
                f'{code} is already released with SHA-256 {held}, and these files are {digest}. A release '
                'never changes: if the data needs correcting, cut it in the next month\'s release.')
        for n in names:                      # restore a lost staged copy (same bytes, so the same release)
            if not (files_dir / n).exists():
                files_dir.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src / n, files_dir / n)
        return code, False

    previous = previous_release(meta_root, meta['dataset'], code)
    dataset, version = meta['dataset'], code.rsplit('-', 1)[1]
    files = []
    for n in names:
        info = meta.get('files', {}).get(n, {})
        files.append({'name': n, 'sha256': shas[n], 'bytes': (src / n).stat().st_size,
                      **{k: info.get(k) for k in FILE_INFO}, 'url': f'{SITE}/releases/{code}/{n}'})
        files[-1] = {k: v for k, v in files[-1].items() if v is not None or k == 'rows'}
    manifest = {
        'code': code,
        'dataset': dataset,
        'title': meta['title'],
        'description': meta.get('description'),
        'released': day,
        'sha256': digest,
        'sha256_of': 'SHA256SUMS',
        'pin': f'{code}+sha256:{digest}',
        'files': files,
        'licence': meta['licence'],
        'attribution': {'sources': meta['sources'],
                        'compiled_by': 'bharatlas (https://bharatlas.com; https://github.com/urbanmorph/geodata)'},
        'citation': _citation(meta, code, digest),
        'url': f'{SITE}/releases/{code}/',
        'w3id_proposed': f'{W3ID}{dataset}/{version}',
        'previous': previous,
    }
    for k in ('method', 'layer'):
        if meta.get(k):
            manifest[k] = meta[k]
    prev_manifest = _manifest(meta_root, previous) if previous else None

    files_dir.mkdir(parents=True, exist_ok=True)
    for n in names:
        shutil.copyfile(src / n, files_dir / n)
    _write_if_changed(meta_dir / 'SHA256SUMS', sums)
    _write_if_changed(meta_dir / 'CHANGES.md', _changes(code, meta, files, previous, prev_manifest, digest, day))
    _write_if_changed(meta_dir / 'manifest.json', json.dumps(manifest, indent=1, ensure_ascii=False) + '\n')
    return code, True


# ── a layer's release ───────────────────────────────────────────────────────

def layer_files(layer: dict) -> dict[str, str]:
    """{release file name: the URL its bytes come from}: the parquet and the downloads, named by the layer id."""
    return {f'{layer["id"]}.{ext}': layer[fmt]['url'] for fmt, ext in LAYER_FORMATS.items()
            if (layer.get(fmt) or {}).get('url')}


def _sql(query: str, *params):
    import duckdb
    return duckdb.connect().execute(query, list(params)).fetchall()


def _q(column: str) -> str:
    return '"' + column.replace('"', '""') + '"'


def _type(duckdb_type: str) -> str:
    """A column type as the manifest records it: a geometry's CRS (pages of PROJJSON) left out."""
    return 'GEOMETRY' if duckdb_type.startswith('GEOMETRY') else duckdb_type


def parquet_info(path: Path) -> dict:
    """Row count and columns (name, DuckDB type) of a parquet file."""
    cols = _sql('DESCRIBE SELECT * FROM read_parquet(?)', str(path))
    return {'rows': _sql('SELECT count(*) FROM read_parquet(?)', str(path))[0][0],
            'columns': [{'name': c[0], 'type': _type(c[1])} for c in cols]}


def _is_id(path: Path, column: str) -> bool:
    """Whether the column's values are unique and never empty."""
    n, distinct, filled = _sql(f'SELECT count(*), count(DISTINCT {_q(column)}), count({_q(column)}) '
                               'FROM read_parquet(?)', str(path))[0]
    return n == distinct == filled


def stable_id_column(cur: Path, prev: Path) -> str | None:
    """The first id-like column (id, *_id, *code*, *lgd*) unique and never empty in both versions."""
    prev_cols = {c['name'] for c in parquet_info(prev)['columns']}
    for c in parquet_info(cur)['columns']:
        if c['name'] in prev_cols and _ID_NAME.search(c['name']) and not _ROW_NUMBER.match(c['name']) \
                and c['type'] not in ('BLOB', 'GEOMETRY') \
                and _is_id(cur, c['name']) and _is_id(prev, c['name']):
            return c['name']
    return None


def _only_in(a: Path, b: Path, column: str) -> list:
    """Values of the column in a's parquet and not in b's, sorted."""
    c = _q(column)
    return [r[0] for r in _sql(f'SELECT {c} FROM read_parquet(?) EXCEPT SELECT {c} FROM read_parquet(?) '
                               'ORDER BY 1', str(a), str(b))]


def _listed(ids: list) -> str:
    shown = ', '.join(str(i) for i in ids[:MAX_IDS_LISTED])
    return shown + (f' and {len(ids) - MAX_IDS_LISTED:,} more' if len(ids) > MAX_IDS_LISTED else '')


def layer_diff(cur: Path, prev_file: dict, prev: Path | None) -> list[str]:
    """CHANGES.md lines for the layer's parquet against its previous release (that release's manifest entry, and
    its parquet if at hand)."""
    now = parquet_info(cur)
    a, b = prev_file.get('rows'), now['rows']
    lines = ['Layer data (the parquet):', '']
    if a is not None:
        lines.append(f'- Rows: {a:,} to {b:,} ({b - a:+,})')
    before = {c['name']: c['type'] for c in prev_file.get('columns') or []}
    after = {c['name']: c['type'] for c in now['columns']}
    if before:
        added, removed = [c for c in after if c not in before], [c for c in before if c not in after]
        retyped = [f'{c} ({before[c]} to {after[c]})' for c in after if c in before and before[c] != after[c]]
        for label, cols in (('added', added), ('removed', removed), ('retyped', retyped)):
            if cols:
                lines.append(f'- Columns {label}: {", ".join(cols)}')
        if not (added or removed or retyped):
            lines.append('- Columns: unchanged')
    col = stable_id_column(cur, prev) if prev and prev.exists() else None
    if col:
        add, gone = _only_in(cur, prev, col), _only_in(prev, cur, col)
        lines.append(f'- By {col}: {len(add):,} added' + (f' ({_listed(add)})' if add else '') +
                     f', {len(gone):,} removed' + (f' ({_listed(gone)})' if gone else ''))
    elif prev and prev.exists():
        lines.append('- Features: no stable id column, so compared by row count only')
    else:
        lines.append('- Features: the previous parquet is not at hand, so compared by row count only')
    return lines


def _title(layer: dict, catalog: dict) -> str:
    meta = catalog.get('level_meta') or {}
    label = (meta.get(layer['id']) or meta.get(layer.get('level')) or {}).get('label') \
        or ((catalog.get('levels') or {}).get(layer.get('level')) or {}).get('plural', '').capitalize()
    return f'{label}, {layer["source"]}' if label else layer['id']


def _sources(layer: dict) -> list[dict]:
    att = layer.get('attribution') or {}
    out = []
    for role in ('primary', 'publisher'):
        s = att.get(role)
        if s and s.get('name') and s['name'] not in [o['name'] for o in out]:
            out.append({'name': s['name'], 'url': s.get('url')})
    if out:
        out[0]['fetched'] = layer.get('fetched_at')
        fp = (layer.get('source_check') or {}).get('fingerprint')
        if fp:
            out[0]['version'] = fp
    return out or [{'name': layer['source'], 'fetched': layer.get('fetched_at')}]


def stage_layer(layer: dict, catalog: dict, src: Path, out: Path, day: str, meta_root: Path = META_ROOT,
                files_root: Path = FILES_ROOT, fetch=None) -> Path:
    """Write the staging folder of a layer's release (its files and release-meta.json) from the files in `src`
    (named as layer_files names them). `fetch(url, dest)` gets the previous release's parquet when it is not in
    `files_root`; without it the diff is by row count and schema only."""
    files = layer_files(layer)
    missing = [n for n in files if not (src / n).is_file()]
    if missing:
        raise FileNotFoundError(f'{layer["id"]}: not in {src}: {", ".join(missing)}')
    out.mkdir(parents=True, exist_ok=True)
    for p in out.iterdir():
        if p.is_file() and p.name not in files and p.name != META_FILE:
            p.unlink()
    info = {}
    for name, url in files.items():
        shutil.copyfile(src / name, out / name)
        info[name] = {'licence': layer.get('licence'), 'source_url': url}
    pq_name = f'{layer["id"]}.parquet'
    if pq_name in files:
        info[pq_name].update(parquet_info(out / pq_name))

    changes = []
    prev = previous_release(meta_root, layer['id'], release_code(layer['id'], day))
    prev_file = next((f for f in _manifest(meta_root, prev)['files'] if f['name'] == pq_name), None) if prev else None
    if prev_file and pq_name in files:
        prev_pq = files_root / prev / pq_name
        if not prev_pq.exists() and fetch:
            fetch(prev_file['url'], prev_pq)
        changes = layer_diff(out / pq_name, prev_file, prev_pq)

    meta = {'dataset': layer['id'], 'title': _title(layer, catalog), 'description': layer.get('notes'),
            'licence': layer.get('licence'), 'sources': _sources(layer), 'files': info,
            'layer': {'id': layer['id'], 'view': f'{SITE}/view/{layer["id"]}'}, 'changes': changes}
    (out / META_FILE).write_text(json.dumps(meta, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    return out


def fetch_layer(layer: dict, src: Path) -> Path:
    """Download the layer's release files into `src`, once: a file is fetched again only when the catalog now
    names another URL for it (recorded beside it) or its size differs from the catalog's."""
    from pipeline import download
    for name, url in layer_files(layer).items():
        dest, mark = src / name, src / f'{name}.url'
        fmt = next(f for f, ext in LAYER_FORMATS.items() if name.endswith('.' + ext))
        want = layer[fmt].get('bytes')
        stale = dest.exists() and (not mark.exists() or mark.read_text() != url
                                   or (want and dest.stat().st_size != want))
        if stale:
            dest.unlink()
        download(url, dest)
        mark.write_text(url)
    return src


def write_index(meta_root: Path = META_ROOT) -> bool:
    """web/public/releases/index.json: every release, newest first, and the latest code per dataset."""
    listing, latest = [], {}
    for code in _codes(meta_root):
        m = _manifest(meta_root, code)
        latest.setdefault(m['dataset'], code)
        listing.append({
            'code': code, 'dataset': m['dataset'], 'title': m['title'], 'released': m['released'],
            'sha256': m['sha256'], 'pin': m['pin'], 'url': m['url'], 'w3id_proposed': m['w3id_proposed'],
            'manifest': f'{SITE}/releases/{code}/manifest.json', 'previous': m.get('previous'),
            'files': [{k: f.get(k) for k in ('name', 'url', 'sha256', 'bytes', 'rows', 'licence')}
                      for f in m['files']],
        })
    doc = {'note': 'bharatlas releases: each code is immutable and pinned by its SHA-256. '
                   'Data from others keeps its source\'s licence; credit the source first.',
           'latest': dict(sorted(latest.items())), 'releases': listing}
    return _write_if_changed(meta_root / 'index.json', json.dumps(doc, indent=1, ensure_ascii=False) + '\n')


def upload_keys(code: str, files_root: Path = FILES_ROOT) -> list[tuple[Path, str]]:
    """(staged file, R2 key) for each of a release's files."""
    return [(p, f'releases/{code}/{p.name}') for p in sorted((files_root / code).iterdir())]


def upload_release(code: str, files_root: Path = FILES_ROOT, s3=None) -> int:
    """Upload a release's files (new_only: a release key never gets other bytes), then check each on R2
    by size and md5. Returns how many files were checked."""
    import pipeline
    s3 = s3 or pipeline.patient_r2_client()
    keys = upload_keys(code, files_root)
    for local, key in keys:
        pipeline.r2_upload_retrying(s3, local, key, new_only=True)
        pipeline.r2_verify(s3, local, key)
        print(f'  on R2, verified: {key}', flush=True)
    return len(keys)


def _cut(src: Path, day: str, meta_root: Path = META_ROOT, files_root: Path = FILES_ROOT,
         upload: bool = False) -> str | None:
    """Cut one staging folder and print what happened (and upload it with `upload`); the code, or None
    when the release is refused."""
    try:
        code, made = make_release(src, day, meta_root, files_root)
    except ReleaseChanged as e:
        print(f'release refused: {e}', file=sys.stderr, flush=True)
        return None
    print(f'{code}: {"released" if made else "already released, unchanged"}  {_manifest(meta_root, code)["pin"]}',
          flush=True)
    if upload:
        upload_release(code, files_root)
    elif made:
        print(f'  to upload, re-run with --upload (R2 creds in the env); keys in s3://{BUCKET}:', flush=True)
        for _, key in upload_keys(code, files_root):
            print(f'    {key}', flush=True)
    return code


def _layer(catalog: dict, layer_id: str) -> dict:
    layer = next((lyr for lyr in catalog['layers'] if lyr['id'] == layer_id), None)
    if not layer:
        raise SystemExit(f'no layer {layer_id!r} in catalog.json')
    return layer


def release_layer(layer: dict, catalog: dict, day: str, dry_run: bool = False, upload: bool = False) -> str | None:
    """Fetch, stage and cut a layer's release. A dry run cuts it into a temporary copy of the releases (and
    never uploads)."""
    from pipeline import download
    code = release_code(layer['id'], day)
    src = fetch_layer(layer, STAGING_ROOT / layer['id'] / 'src')
    if not dry_run:
        stage = stage_layer(layer, catalog, src, STAGING_ROOT / layer['id'] / code, day, fetch=download)
        return _cut(stage, day, upload=upload)
    with tempfile.TemporaryDirectory() as tmp:
        meta_root, files_root = Path(tmp) / 'releases', Path(tmp) / 'files'
        shutil.copytree(META_ROOT, meta_root)
        stage = stage_layer(layer, catalog, src, Path(tmp) / 'stage', day, meta_root, FILES_ROOT, fetch=download)
        print(f'[dry run] {code}: nothing is written under {META_ROOT.relative_to(ROOT)}', flush=True)
        if _cut(stage, day, meta_root, files_root):
            m = _manifest(meta_root, code)
            print(json.dumps({k: m[k] for k in ('code', 'title', 'licence', 'pin', 'previous', 'w3id_proposed')},
                             indent=1, ensure_ascii=False), flush=True)
            for f in m['files']:
                print(f'  {f["name"]}: {f["bytes"]:,} bytes, sha256 {f["sha256"]}, from {f.get("source_url")}',
                      flush=True)
            print((meta_root / code / 'CHANGES.md').read_text(encoding='utf-8'), flush=True)
            return code
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('staging', nargs='*', help='staging folders, each with a release-meta.json')
    ap.add_argument('--layer', nargs='+', metavar='ID', default=[], help='cut these layers\' releases')
    ap.add_argument('--dry-run', action='store_true', help='with --layer: cut into a temporary copy, write nothing')
    ap.add_argument('--date', default=datetime.now(timezone.utc).date().isoformat())
    ap.add_argument('--index-only', action='store_true')
    ap.add_argument('--upload', action='store_true', help='upload each release cut (or already cut) to R2')
    args = ap.parse_args(argv)
    upload = args.upload and not args.dry_run
    ok = True
    if not args.index_only:
        ok = all([_cut(Path(src), args.date, upload=upload) for src in args.staging])
        catalog = json.loads(CATALOG.read_text()) if args.layer else {}
        ok = all([release_layer(_layer(catalog, lid), catalog, args.date, args.dry_run, upload)
                  for lid in args.layer]) and ok
    if args.dry_run:
        return 0 if ok else 1
    print(f'index: {"written" if write_index() else "unchanged"}', flush=True)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
