"""Run SQL on the bharatlas D1 database through wrangler (the one helper).

Prefers a `wrangler` on PATH that actually runs (a broken mise shim exists on
PATH but exits non-zero), else `npx --yes wrangler@4` (pinned major). Every
call has a timeout: wrangler has hung for minutes. A local CLOUDFLARE_API_TOKEN
is often R2-scoped and shadows `wrangler login` (which has D1), so a failed
call is retried once without it.
"""
from __future__ import annotations

import functools
import json
import os
import subprocess

DATABASE = 'geodata-submissions'
WRANGLER = ['npx', '--yes', 'wrangler@4']


class D1Error(RuntimeError):
    pass


@functools.cache
def wrangler_bin() -> list[str]:
    try:
        if subprocess.run(['wrangler', '--version'], capture_output=True, text=True, timeout=60).returncode == 0:
            return ['wrangler']
    except (OSError, subprocess.TimeoutExpired):
        pass
    return list(WRANGLER)


def esc(s: str) -> str:
    """A string for a single-quoted SQL literal."""
    return s.replace("'", "''")


def query(sql: str, scope: str = 'remote', *, extra: tuple[str, ...] = (), cwd: str | os.PathLike | None = None,
          timeout: float = 180) -> list[dict]:
    """The result rows of `sql` on D1 (`scope` is 'remote' or 'local')."""
    cmd = [*wrangler_bin(), 'd1', 'execute', DATABASE, f'--{scope}', '--json', '--command', sql, *extra]

    def run(env: dict | None = None) -> subprocess.CompletedProcess:
        try:
            return subprocess.run(cmd, capture_output=True, text=True, cwd=cwd, env=env, timeout=timeout)
        except subprocess.TimeoutExpired as e:
            raise D1Error(f'wrangler d1 execute timed out after {timeout:.0f} s') from e
        except OSError as e:
            raise D1Error(f'wrangler could not start: {e}') from e

    proc = run()
    if proc.returncode != 0 and 'CLOUDFLARE_API_TOKEN' in os.environ:
        proc = run({k: v for k, v in os.environ.items() if k != 'CLOUDFLARE_API_TOKEN'})
    if proc.returncode != 0:
        raise D1Error(f'wrangler d1 execute failed (exit {proc.returncode}); is wrangler authed for --{scope} '
                      f'with D1 access?\n{(proc.stderr or proc.stdout).strip()}')
    data = json.loads(proc.stdout)
    return data[0].get('results', []) if data else []
