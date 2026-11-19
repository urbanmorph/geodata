#!/usr/bin/env python3
"""
Which layers' upstream sources have changed since bharatlas ingested them?

For every layer's `source_check` in catalog.json (written by scripts/populate_source_check.py) this asks the
upstream for metadata only (a HEAD, a release or commit listing, a dataset record); it never downloads a data
file. Each answer becomes a fingerprint, compared with the one recorded in catalog.json:

  unchanged  same fingerprint (or, before one is recorded, the source's own date is not after fetched_at)
  changed    a different fingerprint (or, before one is recorded, the source is dated after fetched_at)
  baseline   no fingerprint recorded yet and no source date to compare: accept one with --accept-all-unchanged
  error      the request failed; the message says why
  manual     no machine check (source_check.reason says why); no request is made

Results go to data/update-status.json ({layer_id: {status, method, url, old, new, new_date, checked_at, error}}),
saved after every answer, so a killed run resumes: an entry checked within --max-age-hours with the same method,
URL and recorded fingerprint is not asked again, and a second run inside that window changes nothing.
--max-minutes stops starting requests before a CI job limit; what was done is kept.

Polite: generic User-Agent, 4 workers, one request at a time per host with a delay between them, timeouts, one
retry with backoff on a server error or timeout. Each GitHub release, repository folder or URL is asked once
per run however many layers share it. Set GITHUB_TOKEN (CI does) for GitHub's higher API limit.

catalog.json is only written by --accept / --accept-all-unchanged:
    python3 scripts/check_updates.py                          # check, write data/update-status.json
    python3 scripts/check_updates.py --accept wards_delhi     # after re-ingesting: record the new fingerprint
    python3 scripts/check_updates.py --accept-all-unchanged   # record fingerprints where none is recorded yet
    python3 scripts/check_updates.py --issue-body data/update-issue.md   # also write the GitHub issue text

The issue also lists the layers due or overdue for a rebuild by their `refresh` block (scripts/populate_refresh.py):
a fast layer a month after its last refresh; a regular layer likewise, but only once its source has changed; slow
layers go by the changed table; frozen layers never. The last refresh is the last build (fetched_at, or the newest
release) or, if later, the last check that found the source unchanged, when that check is strong: an exact
fingerprint of the data (a release asset, a commit, a dataset record, a data file's headers). A weak check (an
OpenStreetMap extract, a GTFS feed, a landing page, a layer checked by hand) never counts: populate_refresh.weak_check
lists the rule per method. The date comes from data/update-status.json, which CI restores between runs and this run
has just refreshed.
"""
from __future__ import annotations

import argparse
import email.utils
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlencode, urlparse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from catalog_record import github_asset  # noqa: E402
from pipeline import is_client_error, log, with_retries, write_json  # noqa: E402
from populate_refresh import RELEASES, last_build, last_refresh, load_releases, next_due, weak_check  # noqa: E402

ROOT = HERE.parent
CATALOG = ROOT / 'catalog.json'
STATUS = ROOT / 'data' / 'update-status.json'
USER_AGENT = 'bharatlas-update-check/1.0'
GH_API = 'https://api.github.com'
WORKERS = 4
HOST_DELAY_S = 1.0
TIMEOUT_S = 30
ISSUE_TITLE = 'Source updates'

_GH_REPO = re.compile(r'^https://github\.com/([^/]+/[^/]+)/?$')
GH_FOLDER = re.compile(r'^https://github\.com/([^/]+/[^/]+)/tree/([^/]+)/(.+)$')


class CheckError(Exception):
    """The source answered, but not with anything a fingerprint can be made from."""


class TimeUp(Exception):
    """The run reached its own time limit before this request started."""


# ── dates ───────────────────────────────────────────────────────────────────

def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def utc_now() -> str:
    return iso(datetime.now(timezone.utc))


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def parse_date(s: str) -> datetime:
    """ISO 8601 with or without a zone (none means UTC); a bare date means the end of that day."""
    if re.fullmatch(r'\d{4}-\d{2}-\d{2}', s):
        return datetime.fromisoformat(s).replace(tzinfo=timezone.utc) + timedelta(days=1, seconds=-1)
    dt = datetime.fromisoformat(s.replace('Z', '+00:00'))
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ── what to ask, and what the answer means ──────────────────────────────────

def request_of(check: dict) -> tuple[str, str]:
    """('head' | 'json', url): the one request that answers this check. Layers sharing it share the answer."""
    method, url = check.get('method'), check.get('url') or ''
    if method == 'http':
        return 'head', url
    if method == 'github_release':
        asset = github_asset(url)
        if asset:
            return 'json', f'{GH_API}/repos/{asset[0]}/releases/tags/{quote(asset[1], safe="")}'
        m = _GH_REPO.match(url)
        if m:
            return 'json', f'{GH_API}/repos/{m.group(1)}/releases/latest'
        raise CheckError(f'not a GitHub release or repository URL: {url}')
    if method == 'github_commit':
        m = GH_FOLDER.match(url)
        if not m:
            raise CheckError(f'not a GitHub folder URL: {url}')
        q = urlencode({'sha': m.group(2), 'path': unquote(m.group(3)), 'per_page': 1}, quote_via=quote)
        return 'json', f'{GH_API}/repos/{m.group(1)}/commits?{q}'
    if method == 'ckan':
        return 'json', url
    if method == 'gtfs':
        # TODO: fetch feed_info.txt alone (a ranged read of the zip's central directory) and use feed_version
        raise CheckError('gtfs checks are not built yet (feed_info.feed_version)')
    raise CheckError(f'unknown method {method!r}')


def _http(headers: dict) -> tuple[str, str | None]:
    parts = [(k, headers.get(k)) for k in ('etag', 'last-modified')] + [('length', headers.get('content-length'))]
    fp = ' '.join(f'{k}={v}' for k, v in parts if v)
    if not fp:
        raise CheckError('no ETag, Last-Modified or Content-Length in the answer')
    lm = headers.get('last-modified')
    return fp, iso(email.utils.parsedate_to_datetime(lm)) if lm else None


def _github_release(check: dict, release: dict) -> tuple[str, str | None]:
    asset = github_asset(check['url'])
    if not asset:
        return f'tag={release["tag_name"]}', release.get('published_at')
    a = next((a for a in release.get('assets', []) if a.get('name') == asset[2]), None)
    if not a:
        raise CheckError(f'release {asset[1]} has no asset {asset[2]}')
    return f'updated_at={a["updated_at"]} size={a["size"]}', a['updated_at']


def _github_commit(commits: list) -> tuple[str, str | None]:
    if not commits:
        raise CheckError('no commits touch this folder')
    c = commits[0]
    return f'commit={c["sha"]}', c['commit']['committer']['date']


def _ckan(doc: dict) -> tuple[str, str | None]:
    if 'result' in doc:                     # CKAN package_show
        mod = doc['result']['metadata_modified']
        return f'metadata_modified={mod}', iso(parse_date(mod.split('.')[0]))
    rows = (doc.get('data') or {}).get('rows')
    if rows:                                # data.gov.in's resource listing: counts change daily, `changed` doesn't
        changed = max(r['changed'][0] for r in rows)
        return f'resources={doc["total"]} changed={changed}', iso(datetime.fromtimestamp(changed, timezone.utc))
    raise CheckError('no dataset record in the answer')


def fingerprint(check: dict, answer) -> tuple[str, str | None]:
    """(fingerprint, the source's own date of this version or None) from the answer to request_of(check)."""
    method = check['method']
    if method == 'http':
        return _http(answer)
    if method == 'github_release':
        return _github_release(check, answer)
    if method == 'github_commit':
        return _github_commit(answer)
    if method == 'ckan':
        return _ckan(answer)
    raise CheckError(f'unknown method {method!r}')


def classify(old: str | None, new: str, new_date: str | None, fetched_at: str | None) -> str:
    if old:
        return 'unchanged' if new == old else 'changed'
    if new_date and fetched_at:
        return 'changed' if parse_date(new_date) > parse_date(fetched_at) else 'unchanged'
    return 'baseline'


# ── the network, politely ───────────────────────────────────────────────────

class HostGate:
    """One request at a time per host, `delay` seconds apart; other hosts go on meanwhile."""

    def __init__(self, delay: float = HOST_DELAY_S, clock=time.monotonic, sleep=time.sleep):
        self.delay, self.clock, self.sleep = delay, clock, sleep
        self.lock = threading.Lock()
        self.next: dict[str, float] = {}

    def wait(self, host: str) -> None:
        with self.lock:
            now = self.clock()
            at = max(now, self.next.get(host, now))
            self.next[host] = at + self.delay
        if at > now:
            self.sleep(at - now)


class KeepMethodRedirect(urllib.request.HTTPRedirectHandler):
    """urllib turns a redirected HEAD into a GET, which would start downloading the data file: keep it a HEAD.
    And keep the GitHub token from following a redirect to another host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None:
            new.method = req.get_method()
            if urlparse(newurl).netloc != urlparse(req.full_url).netloc:
                new.remove_header('Authorization')
        return new


_OPENER = urllib.request.build_opener(KeepMethodRedirect)


class Client:
    def __init__(self, gate: HostGate | None = None, tries: int = 2, token: str | None = None):
        self.gate = gate or HostGate()
        self.tries = tries
        self.token = token

    def _open(self, url: str, method: str = 'GET', headers: dict | None = None):
        h = {'User-Agent': USER_AGENT, **(headers or {})}
        if self.token and url.startswith(GH_API):
            h['Authorization'] = f'Bearer {self.token}'
        self.gate.wait(urlparse(url).netloc)
        return _OPENER.open(urllib.request.Request(url, method=method, headers=h), timeout=TIMEOUT_S)

    def _retrying(self, fn):
        return with_retries(fn, self.tries, wait=lambda n: time.sleep(5 * n), give_up=is_client_error)

    def head_meta(self, url: str) -> dict:
        """ETag, Last-Modified and Content-Length from a HEAD, or from a GET of the first byte if HEAD is refused."""
        def head():
            with self._open(url, 'HEAD') as r:
                return {k.lower(): v for k, v in r.headers.items()}

        def first_byte():
            with self._open(url, headers={'Range': 'bytes=0-0'}) as r:     # closed before the body is read
                h = {k.lower(): v for k, v in r.headers.items()}
            total = (h.get('content-range') or '').rpartition('/')[2]
            if r.status == 206 and total.isdigit():
                h['content-length'] = total
            return h
        try:
            return self._retrying(head)
        except urllib.error.HTTPError as e:
            if e.code not in (400, 403, 405, 501):
                raise
        return self._retrying(first_byte)

    def get_json(self, url: str):
        def get():
            with self._open(url, headers={'Accept': 'application/json'}) as r:
                return json.load(r)
        return self._retrying(get)


# ── a run ───────────────────────────────────────────────────────────────────

def load_status(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


def save_status(path: Path, status: dict) -> None:
    text = json.dumps(status, indent=1, sort_keys=True) + '\n'
    if path.exists() and path.read_text() == text:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_name(path.name + '.part')
    part.write_text(text)
    os.replace(part, path)


def _same_check(prev: dict, check: dict) -> bool:
    """Did this status entry ask the layer's current source about its current recorded version?"""
    return (prev.get('method'), prev.get('url'), prev.get('old')) == (
        check.get('method'), check.get('url'), check.get('fingerprint'))


def _fresh(prev: dict | None, check: dict, now: str, max_age_hours: float) -> bool:
    if not prev or not prev.get('checked_at'):
        return False
    return _same_check(prev, check) and parse_date(now) - parse_date(prev['checked_at']) < timedelta(hours=max_age_hours)


def _entry(check: dict, now: str, **kw) -> dict:
    """A status entry; an error unless `kw` says otherwise."""
    return {'status': 'error', 'method': check.get('method'), 'url': check.get('url'),
            'old': check.get('fingerprint'), 'new': None, 'new_date': None, 'checked_at': now, 'error': None, **kw}


def _result(layer: dict, answer, err: str | None, now: str) -> dict:
    check = layer['source_check']
    if err:
        return _entry(check, now, error=err)
    try:
        new, new_date = fingerprint(check, answer)
    except (CheckError, KeyError, TypeError, ValueError) as e:     # an answer of an unexpected shape
        return _entry(check, now, error=f'{type(e).__name__}: {e}')
    return _entry(check, now, new=new, new_date=new_date,
                  status=classify(check.get('fingerprint'), new, new_date, layer.get('fetched_at')))


def run(catalog: dict, out: Path, client, now=utc_now, max_minutes: float = 20, max_age_hours: float = 20,
        workers: int = WORKERS) -> dict:
    layers = {lyr['id']: lyr for lyr in catalog['layers'] if lyr.get('source_check')}
    status = {k: v for k, v in load_status(out).items() if k in layers}
    started = now()
    due: dict[tuple[str, str], list[str]] = {}
    for lid, lyr in layers.items():
        check = lyr['source_check']
        if check['method'] == 'manual':
            status[lid] = {'status': 'manual', 'method': 'manual', 'url': check.get('url'),
                           'reason': check.get('reason')}
        elif not _fresh(status.get(lid), check, started, max_age_hours):
            try:
                due.setdefault(request_of(check), []).append(lid)
            except CheckError as e:
                status[lid] = _entry(check, started, error=str(e))
    save_status(out, status)
    n_due = sum(map(len, due.values()))
    log(f'{len(layers)} layers: {n_due} to check with {len(due)} requests, '
        f'{len(layers) - n_due} manual or checked within {max_age_hours:g} h')

    deadline = time.monotonic() + max_minutes * 60

    def ask(key):
        if time.monotonic() >= deadline:
            raise TimeUp
        kind, url = key
        return client.head_meta(url) if kind == 'head' else client.get_json(url)

    done, stopped = 0, False
    with ThreadPoolExecutor(workers) as pool:
        futures = {pool.submit(ask, key): key for key in due}
        for fut in as_completed(futures):
            key = futures[fut]
            try:
                answer, err = fut.result(), None
            except TimeUp:
                stopped = True
                continue
            except Exception as e:      # one source failing must not lose the rest
                answer, err = None, f'{type(e).__name__}: {e}'
            for lid in due[key]:
                entry = status[lid] = _result(layers[lid], answer, err, now())
                done += 1
                detail = entry['error'] or (f'{entry["old"]} -> {entry["new"]}' if entry['status'] == 'changed'
                                            else '')
                log(f'[{done}/{n_due}] {lid}: {entry["status"]} {detail}'.rstrip())
            save_status(out, status)
    if stopped:
        log(f'time limit of {max_minutes:g} min reached: re-run to check the rest')
    save_status(out, status)
    return status


# ── accepting a new version into catalog.json ───────────────────────────────

def _record(check: dict, entry: dict) -> None:
    check['fingerprint'] = entry['new']
    check['checked_at'] = entry['checked_at']
    check['changed_at'] = entry.get('new_date')
    entry.update(status='unchanged', old=entry['new'])


def accept(catalog: dict, status: dict, ids: list[str]) -> list[str]:
    """Record each layer's last checked fingerprint as the version bharatlas now holds (after a re-ingest)."""
    by_id = {lyr['id']: lyr for lyr in catalog['layers']}
    bad = [i for i in ids if i not in by_id or not (status.get(i) or {}).get('new')]
    if bad:
        raise SystemExit(f'no checked fingerprint to accept for: {", ".join(bad)} (run the check first)')
    for i in ids:
        _record(by_id[i]['source_check'], status[i])
    return ids


def accept_all_unchanged(catalog: dict, status: dict) -> list[str]:
    """Record a fingerprint for every layer that has none yet and is not reported changed or erroring."""
    done = []
    for lyr in catalog['layers']:
        check, entry = lyr.get('source_check') or {}, status.get(lyr['id']) or {}
        if check.get('method') not in (None, 'manual') and not check.get('fingerprint') \
                and entry.get('status') in ('unchanged', 'baseline') and entry.get('new'):
            _record(check, entry)
            done.append(lyr['id'])
    return done


# ── rebuilds due by the refresh schedule ────────────────────────────────────

def identical_on(layer: dict, entry: dict) -> str | None:
    """YYYY-MM-DD of the check that found the layer's current source unchanged, or None."""
    check = layer.get('source_check') or {}
    if entry.get('status') == 'unchanged' and entry.get('checked_at') and _same_check(entry, check):
        return entry['checked_at'][:10]
    return None


def _why(weak: str | None, entry: dict) -> str:
    if weak:
        return f'weak check: {weak}'
    s = entry.get('status')
    if s == 'changed':
        return 'source changed'
    if s == 'unchanged':
        return 'a month since its source was last confirmed identical'
    return f'source not confirmed identical ({s or "not checked yet"})'


def due_layers(catalog: dict, status: dict, releases: dict | None, on: str) -> list[dict]:
    """Layers whose scheduled rebuild is due on the day `on` (YYYY-MM-DD), most overdue first: a month after the
    last refresh (populate_refresh.last_refresh), with why each is due."""
    out = []
    for lyr in catalog['layers']:
        r = lyr.get('refresh') or {}
        rebuild = r.get('rebuild')
        entry = status.get(lyr['id']) or {}
        if rebuild == 'monthly_if_changed' and entry.get('status') != 'changed':
            continue
        weak = weak_check(lyr)
        same = None if weak else identical_on(lyr, entry)
        due = next_due(rebuild, last_refresh(lyr, releases, same))
        if due and due <= on:
            days = (datetime.fromisoformat(on) - datetime.fromisoformat(due)).days
            out.append({'id': lyr['id'], 'class': r.get('class'), 'rebuild': rebuild,
                        'last_build': last_build(lyr, releases), 'last_identical': same, 'next_due': due,
                        'days_over': days, 'why': _why(weak, entry)})
    return sorted(out, key=lambda d: (-d['days_over'], d['id']))


# ── the GitHub issue ────────────────────────────────────────────────────────

def page_link(url: str | None) -> str:
    """A page a person can open: a release asset's release page rather than the file itself."""
    asset = github_asset(url)
    return f'https://github.com/{asset[0]}/releases/tag/{asset[1]}' if asset else (url or '')


def _cell(s) -> str:
    return str(s if s is not None else '').replace('|', '\\|').replace('\n', ' ')


def summary(status: dict, due: list[dict] | None = None) -> dict:
    counts = Counter(e.get('status') for e in status.values())
    return {'checked_at': max((e['checked_at'] for e in status.values() if e.get('checked_at')), default=None),
            'counts': dict(counts),
            'changed': sorted(k for k, e in status.items() if e.get('status') == 'changed'),
            'error': sorted(k for k, e in status.items() if e.get('status') == 'error'),
            'due': [d['id'] for d in due or []],
            'due_count': len(due or [])}


def issue_body(status: dict, catalog: dict, due: list[dict] | None = None) -> str:
    fetched = {lyr['id']: lyr.get('fetched_at') for lyr in catalog['layers']}
    s = summary(status, due)
    c = s['counts']
    lines = [f'Weekly check of each layer\'s upstream source (metadata only), last run {s["checked_at"]}: '
             f'{c.get("changed", 0)} changed, {c.get("error", 0)} errors, {c.get("unchanged", 0)} unchanged, '
             f'{c.get("baseline", 0)} without a recorded version, {c.get("manual", 0)} checked by hand.', '']
    if s['changed']:
        lines += [f'### Changed since ingest ({len(s["changed"])})', '',
                  '| Layer | Method | Old to new | Link |', '|---|---|---|---|']
        for lid in s['changed']:
            e = status[lid]
            old = e.get('old') or f'none recorded, ingested {(fetched.get(lid) or "?")[:10]}'
            lines.append(f'| {lid} | {e.get("method")} | {_cell(old)} to {_cell(e.get("new"))} | '
                         f'{page_link(e.get("url"))} |')
        lines += ['', 'After re-ingesting a layer, record its new version: '
                      '`python3 scripts/check_updates.py --accept <layer id>`', '']
    else:
        lines += ['No source has changed since it was ingested.', '']
    if s['error']:
        lines += [f'### Errors ({len(s["error"])})', '', '| Layer | Method | Error | Link |', '|---|---|---|---|']
        for lid in s['error']:
            e = status[lid]
            lines.append(f'| {lid} | {e.get("method")} | {_cell(e.get("error"))} | {page_link(e.get("url"))} |')
        lines.append('')
    if due:
        lines += [f'### Due or overdue ({len(due)})', '',
                  'Due a month after the layer\'s last build, or after the last weekly check that confirmed its '
                  'source identical by an exact fingerprint (a release asset, a commit, a dataset record, a data '
                  'file\'s headers); a weak check (OpenStreetMap, GTFS, a page, by hand) never counts.', '',
                  '| Layer | Class | Rebuild | Last build | Confirmed identical | Due | Days over | Why |',
                  '|---|---|---|---|---|---|---|---|']
        lines += [f'| {d["id"]} | {d["class"]} | {d["rebuild"]} | {d["last_build"]} | {d["last_identical"] or ""} | '
                  f'{d["next_due"]} | {d["days_over"]} | {_cell(d["why"])} |' for d in due]
        lines += ['', 'Rebuild with the layer\'s own bake script into versioned keys, then cut its release '
                      '(`python3 scripts/release.py --layer <layer id>`).', '']
    else:
        lines += ['No layer is due for a rebuild.', '']
    lines.append(f'<!-- update-summary {json.dumps(s, sort_keys=True)} -->')
    return '\n'.join(lines) + '\n'


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--catalog', default=str(CATALOG))
    ap.add_argument('--status', default=str(STATUS))
    ap.add_argument('--max-minutes', type=float, default=20, help='stop starting requests after this long')
    ap.add_argument('--max-age-hours', type=float, default=20, help='re-ask a source checked longer ago than this')
    ap.add_argument('--accept', nargs='+', metavar='ID', help='record these layers\' new fingerprints in the catalog')
    ap.add_argument('--accept-all-unchanged', action='store_true',
                    help='record a fingerprint for every unchanged layer that has none yet')
    ap.add_argument('--issue-body', help='also write the "Source updates" issue text (Markdown) here')
    ap.add_argument('--summary', help='also write the summary JSON here')
    ap.add_argument('--releases', default=str(RELEASES), help='the release index, for each layer\'s last build')
    args = ap.parse_args(argv)

    catalog_path, status_path = Path(args.catalog), Path(args.status)
    catalog = json.loads(catalog_path.read_text())
    if args.accept or args.accept_all_unchanged:
        status = load_status(status_path)
        ids = accept(catalog, status, args.accept) if args.accept else accept_all_unchanged(catalog, status)
        if ids:
            write_json(catalog_path, catalog)
            save_status(status_path, status)
        log(f'accepted {len(ids)}: {", ".join(ids)}' if ids else 'nothing to accept')
        return 0

    token = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN')
    status = run(catalog, status_path, Client(token=token), max_minutes=args.max_minutes,
                 max_age_hours=args.max_age_hours)
    due = due_layers(catalog, status, load_releases(Path(args.releases)), today())
    s = summary(status, due)
    log('status: ' + ', '.join(f'{k} {v}' for k, v in sorted(s['counts'].items())) + f'; due {len(due)}')
    if args.issue_body:
        Path(args.issue_body).write_text(issue_body(status, catalog, due))
    if args.summary:
        Path(args.summary).write_text(json.dumps(s, indent=1, sort_keys=True) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
