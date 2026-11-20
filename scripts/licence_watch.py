#!/usr/bin/env python3
"""Each layer's licence as its publisher states it: recorded at ingest, checked again on every re-extract
(pipeline.upsert_layer and ingest_ramseraph call require_unchanged) and every week (check_updates.py).

scripts/licence-terms.json lists the terms documents. Each one names the page that states the licence, how to
read the licence text off it (the slice between two anchor phrases of an HTML or text page, or a path into a
JSON answer such as a CKAN record or the GitHub licence API), the licence as stated, a quote, the sha256 of the
text when it was last reviewed, and the layers it covers. Terms that no page states (an emailed permission)
are kind "manual" and are not fetched.

    python3 scripts/licence_watch.py                 # check every terms document, print what changed
    python3 scripts/licence_watch.py --layer airports  # the gate a re-extract runs (exit 1 on a change)
    python3 scripts/licence_watch.py --accept nrsc   # after reviewing new terms (and relabelling the layers)
    python3 scripts/licence_watch.py --seed          # record a baseline for terms that have none yet

LICENCE_GATE=warn lets a re-extract go on when a terms page cannot be reached (it is still reported).
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import ssl
import sys
import urllib.request
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
REGISTRY = HERE / 'licence-terms.json'
USER_AGENT = 'bharatlas-licence-check/1.0'
TIMEOUT_S = 30


class LicenceTextMissing(ValueError):
    """The page no longer holds the anchors around its licence text."""


class LicenceChanged(RuntimeError):
    """A publisher's licence text differs from the one reviewed at ingest."""


class LicenceNotRecorded(RuntimeError):
    """A layer has no licence terms recorded in licence-terms.json."""


class LicenceUnverified(RuntimeError):
    """A terms page could not be read, so the licence could not be confirmed."""


# ── reading ──────────────────────────────────────────────────────────────────

def _plain(body: str) -> str:
    body = re.sub(r'(?is)<(script|style)\b.*?</\1>', ' ', body)
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', body))).strip()


def extract(terms: dict, body: str) -> str:
    """The licence text of one terms document, normalised (no markup, single spaces)."""
    if terms['kind'] == 'json':
        value = json.loads(body)
        for key in terms['json_path'].removeprefix('$.').split('.'):
            try:
                value = value[int(key)] if isinstance(value, list) else value[key]
            except (KeyError, IndexError, ValueError, TypeError) as e:
                raise LicenceTextMissing(f'{terms["id"]}: no {terms["json_path"]} in the answer') from e
        return value if isinstance(value, str) else json.dumps(value, sort_keys=True)
    text = _plain(body) if terms['kind'] == 'html' else re.sub(r'\s+', ' ', body).strip()
    start = text.find(terms['start'])
    end = text.find(terms['end'], start + len(terms['start'])) if start >= 0 else -1
    if start < 0 or end < 0:
        raise LicenceTextMissing(f'{terms["id"]}: anchors "{terms["start"]}" … "{terms["end"]}" not on the page')
    return text[start:end + len(terms['end'])]


def fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:   # CI's Python has the system store
        return ssl.create_default_context()


def fetch(url: str) -> str:
    headers = {'User-Agent': USER_AGENT}
    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    if token and url.startswith('https://api.github.com/'):
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=TIMEOUT_S, context=_ssl_context()) as r:
        return r.read().decode(r.headers.get_content_charset() or 'utf-8', 'replace')


# ── comparing ────────────────────────────────────────────────────────────────

def check(terms: dict, get=fetch) -> dict:
    """{id, layers, status: same | changed | missing | error | manual, text?, error?}."""
    out = {'id': terms['id'], 'layers': terms.get('layers', []), 'url': terms.get('url')}
    if terms['kind'] == 'manual':
        return {**out, 'status': 'manual'}
    try:
        text = extract(terms, get(terms['url']))
    except LicenceTextMissing as e:
        return {**out, 'status': 'missing', 'error': str(e)}
    except Exception as e:  # noqa: BLE001 — any failure to read the page leaves the licence unconfirmed
        return {**out, 'status': 'error', 'error': f'{type(e).__name__}: {e}'}
    same = fingerprint(text) == terms.get('sha256')
    return {**out, 'status': 'same' if same else 'changed', 'text': text}


def terms_of(layer_id: str, registry: dict) -> list[dict]:
    return [t for t in registry['terms'] if layer_id in t.get('layers', [])]


def require_unchanged(layer_id: str, registry: dict | None = None, get=fetch) -> list[dict]:
    """The gate a re-extract runs before it registers a layer: every terms document of the layer must read as
    it did when last reviewed."""
    registry = registry if registry is not None else load_registry()
    terms = terms_of(layer_id, registry)
    if not terms:
        raise LicenceNotRecorded(f'{layer_id}: record its licence terms in {REGISTRY.name} before registering it')
    results = [check(t, get) for t in terms]
    for r in results:
        if r['status'] in ('changed', 'missing'):
            raise LicenceChanged(f'{layer_id}: the licence terms "{r["id"]}" ({r["url"]}) changed since they were '
                                 f'reviewed. Review them, relabel the layer if needed, then run '
                                 f'python3 scripts/licence_watch.py --accept {r["id"]}')
        if r['status'] == 'error':
            msg = f'{layer_id}: could not read the licence terms "{r["id"]}" ({r["url"]}): {r["error"]}'
            if os.environ.get('LICENCE_GATE') != 'warn':
                raise LicenceUnverified(msg + ' (LICENCE_GATE=warn goes on regardless)')
            print(f'  ! {msg}', flush=True)
    return results


def gate(layer_id: str) -> None:
    """pipeline.upsert_layer's hook (tests swap it out)."""
    for r in require_unchanged(layer_id):
        print(f'  licence terms {r["id"]}: {r["status"]}', flush=True)


# ── labels ───────────────────────────────────────────────────────────────────
# A terms document may set the labels its layers carry: "labels": {"licence", "non_commercial", "credit": {name,
# url}, "via": {name, url}}. Every registration applies them (pipeline.upsert_layer, ingest_ramseraph), so a re-extract never puts
# back a compiler's licence over the publisher's reviewed one.

# credit = the original publisher (attribution.primary); via = the compiler whose licence applies (.publisher)
ATTRIBUTION_LABELS = {'credit': 'primary', 'via': 'publisher'}


def labels_of(layer_id: str, registry: dict) -> dict:
    out: dict = {}
    for t in terms_of(layer_id, registry):
        for k, v in t.get('labels', {}).items():
            if k in out and out[k] != v:
                raise ValueError(f'{layer_id}: terms disagree on {k} ({out[k]!r} vs {v!r} from "{t["id"]}")')
            out[k] = v
    return out


def licence_of(layer_id: str, default: str = 'CC0-1.0', registry: dict | None = None) -> str:
    """The licence a layer's reviewed terms set, else `default` (the compiler's)."""
    return labels_of(layer_id, registry if registry is not None else load_registry()).get('licence', default)


def labelled(entry: dict, registry: dict | None = None) -> dict:
    """The catalog entry with the labels its terms set (a new dict; unchanged when its terms set none)."""
    labels = labels_of(entry['id'], registry if registry is not None else load_registry())
    if not labels:
        return entry
    out = {**entry, **{k: v for k, v in labels.items() if k not in ATTRIBUTION_LABELS}}
    for label, field in ATTRIBUTION_LABELS.items():
        if label in labels:
            out['attribution'] = {'primary': None, 'publisher': None, **(out.get('attribution') or {}),
                                  field: labels[label]}
    return out


# ── recording ────────────────────────────────────────────────────────────────

def load_registry(path: Path = REGISTRY) -> dict:
    return json.loads(path.read_text())


def save_registry(registry: dict, path: Path = REGISTRY) -> None:
    path.write_text(json.dumps(registry, indent=1, ensure_ascii=False) + '\n')


def accept(registry: dict, ids: list[str], get=fetch, today: str | None = None) -> list[str]:
    """Record the current text of these terms as reviewed."""
    done = []
    for t in registry['terms']:
        if t['id'] in ids and t['kind'] != 'manual':
            t['sha256'] = fingerprint(extract(t, get(t['url'])))
            t['seen_at'] = today or date.today().isoformat()
            done.append(t['id'])
    return done


# ── the weekly check ─────────────────────────────────────────────────────────

def seed(registry: dict, get=fetch, today: str | None = None) -> tuple[list[str], dict[str, str]]:
    """Record a baseline for every fetchable terms document that has none; ([recorded], {id: why not})."""
    done, failed = [], {}
    for t in registry['terms']:
        if t['kind'] == 'manual' or t.get('sha256'):
            continue
        try:
            done += accept(registry, [t['id']], get, today)
        except Exception as e:  # noqa: BLE001 — one unreadable page must not stop the others
            failed[t['id']] = f'{type(e).__name__}: {e}'
    return done, failed


def check_all(registry: dict, get=fetch) -> list[dict]:
    return [check(t, get) for t in registry['terms']]


def summary(results: list[dict]) -> dict:
    return {'licence_changed': sorted(r['id'] for r in results if r['status'] in ('changed', 'missing')),
            'licence_error': sorted(r['id'] for r in results if r['status'] == 'error'),
            'licence_checked': sum(r['status'] != 'manual' for r in results)}


def issue_section(results: list[dict]) -> str:
    s = summary(results)
    by_id = {r['id']: r for r in results}
    lines = []
    if s['licence_changed']:
        lines += [f'### Licence terms changed ({len(s["licence_changed"])})', '',
                  'The text of these licence terms differs from the version reviewed at ingest. Read it, relabel '
                  'the layers if the licence changed, then record it as reviewed.', '',
                  '| Terms | Layers | Page | Record as reviewed |', '|---|---|---|---|']
        for tid in s['licence_changed']:
            r = by_id[tid]
            lines.append(f'| {tid} | {", ".join(r["layers"])} | {r["url"]} | '
                         f'`python3 scripts/licence_watch.py --accept {tid}` |')
    else:
        lines.append(f'No licence has changed since it was reviewed ({s["licence_checked"]} terms pages read).')
    if s['licence_error']:
        lines += ['', f'Licence terms that could not be read this week ({len(s["licence_error"])}): '
                  + ', '.join(f'{tid} ({by_id[tid]["error"][:80]})' for tid in s['licence_error'])]
    return '\n'.join(lines) + '\n'


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--layer', help='check the terms of one layer, as a re-extract does')
    ap.add_argument('--accept', nargs='+', metavar='TERMS_ID', help='record these terms as reviewed')
    ap.add_argument('--seed', action='store_true', help='record a baseline for terms that have none')
    args = ap.parse_args(argv)
    registry = load_registry()
    if args.layer:
        try:
            gate(args.layer)
        except (LicenceChanged, LicenceNotRecorded, LicenceUnverified) as e:
            print(e, file=sys.stderr)
            return 1
        return 0
    if args.seed:
        done, failed = seed(registry)
        save_registry(registry)
        print(f'recorded {len(done)}: {", ".join(done)}')
        for tid, why in failed.items():
            print(f'  could not read {tid}: {why}')
        return 0
    if args.accept:
        done = accept(registry, args.accept)
        save_registry(registry)
        print(f'recorded {len(done)}: {", ".join(done)}' if done else 'nothing recorded')
        return 0
    print(issue_section(check_all(registry)), end='')
    return 0


if __name__ == '__main__':
    sys.exit(main())
