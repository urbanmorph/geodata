#!/usr/bin/env python3
"""List layer requests (docs#request) from D1, newest first, for the owner to reply to.

The site sends no email: a request is a row in layer_requests. Read them here, check the layer can be built
(an open source that allows any use: a requested layer is never non-commercial), reply by email, then set
the status. Reads with the deploy token in web/.dev.vars (never printed).

    python3 scripts/list_layer_requests.py              # status 'new'
    python3 scripts/list_layer_requests.py --all
    python3 scripts/list_layer_requests.py --set req_abc123defg feasible   # new | feasible | not_feasible | paid | published
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / 'web'
STATUSES = ('new', 'feasible', 'not_feasible', 'paid', 'published')
DB = 'geodata-submissions'


def table(rows: list[dict]) -> str:
    """The requests as plain lines (the owner's own terminal: the email is shown here, nowhere else)."""
    if not rows:
        return 'No requests.'
    out = []
    for r in rows:
        out.append(f"{r['id']}  {r['created_at'][:16]}  [{r['status']}]  {r['email']}"
                   f"{'  credit: ' + r['credit_name'] if r['credit_name'] else '  (anonymous)'}")
        out.append(f"    what: {r['what']}")
        for k in ('place', 'source', 'query'):
            if r.get(k):
                out.append(f'    {k}: {r[k]}')
    return '\n'.join(out)


def d1(sql: str) -> list[dict]:
    env_file = WEB / '.dev.vars'
    env = dict(line.split('=', 1) for line in env_file.read_text().splitlines() if '=' in line and not line.startswith('#'))
    proc = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
                          cwd=WEB, capture_output=True, text=True, timeout=120,
                          env={**os.environ, **{k.strip(): v.strip() for k, v in env.items()}})
    if proc.returncode:
        sys.exit(proc.stderr.strip() or proc.stdout.strip())
    return json.loads(proc.stdout)[0]['results']


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--set', nargs=2, metavar=('ID', 'STATUS'))
    a = ap.parse_args(argv)
    if a.set:
        rid, status = a.set
        if status not in STATUSES or not re.fullmatch(r'req_[A-Za-z0-9_-]{10}', rid):
            sys.exit(f'usage: --set req_<10 chars> {"|".join(STATUSES)}')
        d1(f"UPDATE layer_requests SET status = '{status}' WHERE id = '{rid}'")
    where = '' if a.all else "WHERE status = 'new'"
    print(table(d1(f'SELECT * FROM layer_requests {where} ORDER BY created_at DESC LIMIT 200')))


if __name__ == '__main__':
    main(sys.argv[1:])
