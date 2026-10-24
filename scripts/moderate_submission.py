#!/usr/bin/env python3
"""Curator moderation for catalog submissions — the human review gate.

Every submission (from the /submit form, from collect, or via the MCP) now lands
as status='pending' and is invisible in the public catalog until a maintainer
approves it here. Nothing is auto-approved.

    python3 scripts/moderate_submission.py                 # list pending submissions
    python3 scripts/moderate_submission.py list            # (same)
    python3 scripts/moderate_submission.py accept <id>     # make it live (status=accepted)
    python3 scripts/moderate_submission.py reject <id> [reason]  # hide it (status=rejected)
    python3 scripts/moderate_submission.py show <id>       # full row for one submission
    python3 scripts/moderate_submission.py check           # every submission missing its file or token

`accept` refuses a submission that is not complete: its file must be in R2 at
the recorded size and its admin token must exist (June 2026: an orphan without
a token went live; Oct 2026: an orphan had no file at all). R2 checks use the
R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CLOUDFLARE_ACCOUNT_ID env (source
web/.dev.vars), as the bake scripts do.

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


def wrangler_bin() -> list[str]:
    """`wrangler` only if it actually runs (a broken mise shim exists on PATH
    but exits non-zero), else npx."""
    try:
        if subprocess.run(['wrangler', '--version'], capture_output=True, text=True).returncode == 0:
            return ['wrangler']
    except (FileNotFoundError, OSError):
        pass
    return ['npx', '--yes', 'wrangler@4']


def d1(sql: str) -> list[dict]:
    cmd = [*wrangler_bin(), 'd1', 'execute', D1_DATABASE, '--remote', '--json', '--command', sql]
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


def r2_size(key: str) -> int | None:
    """Size of the stored object, or None if it is not in R2."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from ingest_ramseraph import BUCKET, r2_client
    s3 = r2_client()
    try:
        return int(s3.head_object(Bucket=BUCKET, Key=key)['ContentLength'])
    except s3.exceptions.ClientError as e:
        if e.response.get('Error', {}).get('Code') in ('404', 'NoSuchKey', 'NotFound'):
            return None
        raise


def integrity_problems(row: dict, stored_size: int | None, admin_tokens: int) -> list[str]:
    """What stops a submission from being complete (empty list: complete)."""
    problems = []
    if stored_size is None:
        problems.append(f"file missing in R2 ({row['r2_key']})")
    elif stored_size != row['bytes']:
        problems.append(f"file in R2 is {stored_size} bytes, expected {row['bytes']}")
    if admin_tokens == 0:
        problems.append('no admin token, so the owner cannot manage it')
    return problems


def problems_for(row: dict) -> list[str]:
    tokens = d1(f"SELECT COUNT(*) n FROM submission_tokens WHERE submission_id='{esc(row['id'])}' AND permission='admin'")
    return integrity_problems(row, r2_size(row['r2_key']), tokens[0]['n'] if tokens else 0)


def list_pending() -> None:
    rows = d1("SELECT id, name, category, feature_count, is_original, source_url, bytes, r2_key, "
              "substr(COALESCE(created_at,''),1,10) day FROM submissions WHERE status='pending' ORDER BY created_at DESC")
    if not rows:
        print('No pending submissions. 🎉')
        return
    print(f'{len(rows)} pending submission(s) awaiting review:\n')
    for r in rows:
        print(f"  {r['id']}  {(r.get('name') or '(no name)')[:44]}")
        print(f"      {r.get('feature_count')} features · {r.get('category')} · {r.get('day')} · {(r.get('source_url') or '')[:50]}")
        for p in problems_for(r):
            print(f'      ✗ {p}: cannot be accepted')
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


def set_status(sub_id: str, status: str, reason: str | None = None) -> None:
    rows = d1(f"SELECT id, name, status, bytes, r2_key FROM submissions WHERE id='{esc(sub_id)}'")
    if not rows:
        sys.exit(f'submission {sub_id!r} not found')
    cur = rows[0]
    if status == 'accepted':
        problems = problems_for(cur)
        if problems:
            sys.exit(f"cannot accept {sub_id}: " + '; '.join(problems))
    extra = f", rejection_reason='{esc(reason)}'" if reason else ''
    d1(f"UPDATE submissions SET status='{status}'{extra} WHERE id='{esc(sub_id)}'")
    print(f"✓ {sub_id} ({cur.get('name') or '(no name)'}): {cur['status']} → {status}")
    if status == 'accepted':
        print('  It is now live in the catalog. Promote to curated parity with:')
        print(f'    python3 scripts/bake_community.py {sub_id}')


def check_all() -> None:
    rows = d1("SELECT id, name, status, bytes, r2_key FROM submissions ORDER BY created_at")
    broken = [(r, p) for r in rows if (p := problems_for(r))]
    print(f'{len(rows)} submissions checked, {len(broken)} incomplete.')
    for r, problems in broken:
        print(f"  {r['id']}  [{r['status']}]  {(r.get('name') or '(no name)')[:40]}")
        for p in problems:
            print(f'      ✗ {p}')


def main() -> None:
    args = sys.argv[1:]
    cmd = args[0] if args else 'list'
    if cmd == 'list':
        list_pending()
    elif cmd == 'show' and len(args) == 2:
        show(args[1])
    elif cmd == 'accept' and len(args) == 2:
        set_status(args[1], 'accepted')
    elif cmd == 'reject' and len(args) >= 2:
        set_status(args[1], 'rejected', ' '.join(args[2:]) or None)
    elif cmd == 'check':
        check_all()
    else:
        sys.exit(__doc__)


if __name__ == '__main__':
    main()
