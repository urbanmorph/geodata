#!/usr/bin/env python3
"""Apply every web/migrations/*.sql to a fresh SQLite in order and assert the
schema invariants collect depends on. D1 is SQLite, so this catches broken DDL
and drift (a later migration re-adding a dropped column, an ALTER that no longer
composes) without touching any real database.

Run: python3 scripts/verify_migrations.py   (exit 0 = pass, 1 = fail)
"""
import glob
import os
import sqlite3
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATIONS = sorted(glob.glob(os.path.join(ROOT, "web", "migrations", "*.sql")))


def apply_all(conn):
    for f in MIGRATIONS:
        try:
            conn.executescript(open(f).read())
        except Exception as e:  # noqa: BLE001
            sys.exit(f"FAIL applying {os.path.basename(f)}: {e}")


def cols(conn, table):
    return [r[1] for r in conn.execute(f"PRAGMA table_info({table})")]


def tables(conn):
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")]


def main():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys=ON")
    apply_all(conn)

    checks = []
    tl = tables(conn)
    for t in ("collections", "collection_tokens", "records",
              "publications", "collect_attempts", "collect_api_keys"):
        checks.append((f"table {t} exists", t in tl))

    c = cols(conn, "collections")
    # geometry lives in schema_doc.geometry; credit line is composed at publish;
    # counts are computed on read — none of these get a column.
    checks += [
        ("collections has data_year", "data_year" in c),
        ("collections has schema_doc", "schema_doc" in c),
        ("collections has NO attribution", "attribution" not in c),
        ("collections has NO geometry_types", "geometry_types" not in c),
        ("collections has NO record_count", "record_count" not in c),
        ("collections has NO published_count", "published_count" not in c),
    ]

    s = cols(conn, "submissions")
    checks += [
        ("submissions gained collection_id", "collection_id" in s),
        ("submissions gained collection_version", "collection_version" in s),
    ]

    r = cols(conn, "records")
    checks += [
        ("records has edit_token_hash", "edit_token_hash" in r),
        ("records has admin_ctx", "admin_ctx" in r),
        ("records gained source (0008)", "source" in r),
    ]

    idx = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' "
        "AND tbl_name='publications' AND sql LIKE '%version%'").fetchone()
    checks.append(("publications UNIQUE(collection_id,version)",
                   idx is not None and "UNIQUE" in (idx[0] or "")))

    ok = True
    for name, passed in checks:
        print("PASS" if passed else "FAIL", name)
        ok = ok and passed

    print()
    print("applied:", ", ".join(os.path.basename(f) for f in MIGRATIONS))
    print("ALL PASS" if ok else "SOME FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
