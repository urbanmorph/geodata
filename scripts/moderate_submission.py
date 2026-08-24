#!/usr/bin/env python3
"""Curator moderation for catalog submissions — the human review gate.

Every submission (from the /submit form, from collect, or via the MCP) now lands
as status='pending' and is invisible in the public catalog until a maintainer
approves it here. Nothing is auto-approved.

    python3 scripts/moderate_submission.py                 # list pending submissions
    python3 scripts/moderate_submission.py list            # (same)
    python3 scripts/moderate_submission.py accept <id>     # make it live (status=accepted)
    python3 scripts/moderate_submission.py reject <id>     # hide it (status=rejected)
    python3 scripts/moderate_submission.py show <id>       # full row for one submission

After `accept`, promote it to curated parity with:
    python3 scripts/bake_community.py <id>

Auth: needs a wrangler that can reach the shared D1 (geodata-submissions), either
via `wrangler login` (oauth with D1) or a D1-scoped CLOUDFLARE_API_TOKEN. If the
env's CLOUDFLARE_API_TOKEN is R2-only it's dropped on a retry (same trick as
bake_community.py), so oauth can handle D1.
"""
import json
import os
import subprocess
import sys

D1_DATABASE = 'geodata-submissions'


def _wrangler_bin() -> list[str]:
    try:
        subprocess.run(['which', 'wrangler'], check=True, capture_output=True)
        return ['wrangler']
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ['npx', '--yes', 'wrangler']


def d1(sql: str) -> list[dict]:
    cmd = [*_wrangler_bin(), 'd1', 'execute', D1_DATABASE, '--remote', '--json', '--command', sql]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 and 'CLOUDFLARE_API_TOKEN' in os.environ:
        env = {k: v for k, v in os.environ.items() if k != 'CLOUDFLARE_API_TOKEN'}
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if proc.returncode != 0:
        sys.exit(f'wrangler d1 execute failed (exit {proc.returncode}); is wrangler authed for --remote '
                 f'with D1 access?\n{(proc.stderr or proc.stdout).strip()}')
    data = json.loads(proc.stdout)
    return data[0].get('results', []) if data else []


def esc(s: str) -> str:
    return s.replace("'", "''")


def list_pending() -> None:
    rows = d1("SELECT id, name, category, feature_count, is_original, source_url, substr(COALESCE(created_at,''),1,10) day "
              "FROM submissions WHERE status='pending' ORDER BY created_at DESC")
    if not rows:
        print('No pending submissions. 🎉')
        return
    print(f'{len(rows)} pending submission(s) awaiting review:\n')
    for r in rows:
        print(f"  {r['id']}  {(r.get('name') or '(no name)')[:44]}")
        print(f"      {r.get('feature_count')} features · {r.get('category')} · {r.get('day')} · {(r.get('source_url') or '')[:50]}")
    print('\nAccept:  python3 scripts/moderate_submission.py accept <id>')
    print('Reject:  python3 scripts/moderate_submission.py reject <id>')


def show(sub_id: str) -> None:
    rows = d1(f"SELECT id, status, name, description, category, license, attribution, feature_count, "
              f"is_original, source_url, data_year, r2_key, substr(COALESCE(created_at,''),1,19) created "
              f"FROM submissions WHERE id='{esc(sub_id)}'")
    if not rows:
        sys.exit(f'submission {sub_id!r} not found')
    for k, v in rows[0].items():
        print(f'  {k}: {v}')


def set_status(sub_id: str, status: str) -> None:
    rows = d1(f"SELECT id, name, status FROM submissions WHERE id='{esc(sub_id)}'")
    if not rows:
        sys.exit(f'submission {sub_id!r} not found')
    cur = rows[0]
    d1(f"UPDATE submissions SET status='{status}' WHERE id='{esc(sub_id)}'")
    print(f"✓ {sub_id} ({cur.get('name') or '(no name)'}): {cur['status']} → {status}")
    if status == 'accepted':
        print('  It is now live in the catalog. Promote to curated parity with:')
        print(f'    python3 scripts/bake_community.py {sub_id}')


def main() -> None:
    args = sys.argv[1:]
    cmd = args[0] if args else 'list'
    if cmd == 'list':
        list_pending()
    elif cmd == 'show' and len(args) == 2:
        show(args[1])
    elif cmd == 'accept' and len(args) == 2:
        set_status(args[1], 'accepted')
    elif cmd == 'reject' and len(args) == 2:
        set_status(args[1], 'rejected')
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
