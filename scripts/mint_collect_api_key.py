#!/usr/bin/env python3
"""Mint a collect API key (the programmatic-abuse gate for collection creation).

The key is shown ONCE and only its SHA-256 is stored (like the collection tokens).
Give it to a trusted programmatic caller (e.g. the collect MCP) via X-API-Key.

Usage:
  python3 scripts/mint_collect_api_key.py --label "mcp: alice" [--daily 50] [--remote]
  # local dev DB:
  python3 scripts/mint_collect_api_key.py --label test --persist-to <wstate>

--remote needs wrangler auth (CLOUDFLARE_API_TOKEN with D1 scope).
Migration 0009 must be applied to the target DB first.
"""
import argparse, hashlib, os, subprocess, sys, uuid
from datetime import datetime, timezone

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
COLLECT = os.path.join(os.path.dirname(__file__), "..", "collect")


def gen_key() -> str:
    return "cak_" + "".join(ALPHABET[b & 0x3F] for b in os.urandom(32))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True, help="who/what this key is for")
    ap.add_argument("--daily", type=int, default=50, help="max collections/day for this key")
    ap.add_argument("--remote", action="store_true", help="target the remote (prod) D1")
    ap.add_argument("--persist-to", default=None, help="local D1 dir (dev)")
    args = ap.parse_args()

    key = gen_key()
    kid = uuid.uuid4().hex
    now = datetime.now(timezone.utc).isoformat()
    label = args.label.replace("'", "''")
    sql = (
        "INSERT INTO collect_api_keys "
        "(id,key_prefix,key_hash,label,daily_limit,created_at,revoked) VALUES "
        f"('{kid}','{key[:8]}','{hashlib.sha256(key.encode()).hexdigest()}',"
        f"'{label}',{args.daily},'{now}',0);"
    )
    cmd = ["npx", "wrangler", "d1", "execute", "geodata-submissions",
           "--remote" if args.remote else "--local", "--command", sql]
    if args.persist_to:
        cmd += ["--persist-to", args.persist_to]
    if subprocess.run(cmd, cwd=COLLECT).returncode != 0:
        sys.exit("failed to insert key")

    print("\n=== collect API key — store securely, shown once ===")
    print(key)
    print(f"label={args.label}  daily_limit={args.daily}  prefix={key[:8]}")


if __name__ == "__main__":
    main()
