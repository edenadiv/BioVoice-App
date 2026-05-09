"""F7.1 — SQLite → Postgres data copy script.

Step 2 of the cutover playbook in `docs/postgres_migration.md`. Walks
every table in the SQLite store and bulk-inserts into Postgres with
ON CONFLICT DO NOTHING so the script is idempotent — safe to re-run
during the brief maintenance window after stopping the backend to
catch any rows written during the bulk copy.

Prerequisites:
  - Postgres reachable at $DATABASE_URL with the schema already
    applied (Alembic upgrade head).
  - psycopg installed: `.venv/bin/pip install 'psycopg[binary]>=3.1'`.

Usage:

    .venv/bin/python scripts/migrate_sqlite_to_postgres.py \\
        --sqlite ./backend/data/biovoice.sqlite3 \\
        --postgres-url postgres://user:pass@host:5432/biovoice

Limitations explicitly out of scope (deferred to F7.1 follow-up):
  - PostgresStore is not yet implemented; this script copies the data
    so the backend can be repointed once that store lands.
  - The Alembic migration for the Postgres schema is not authored —
    operators currently mirror sqlite_store._ensure_schema by hand
    or wait for the migration commit.
  - Embeddings stay TEXT (JSON) rather than upgrading to JSONB; that
    can be done with a follow-up `ALTER TABLE … TYPE jsonb USING
    embedding_json::jsonb` once the schema is in place.
"""

from __future__ import annotations

import argparse
import json
import logging
import sqlite3
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("sqlite_to_postgres")


# Tables in dependency order — parents before children so foreign keys
# don't trip during the copy. Adjust if you add tables to either store.
TABLES = [
    "users",
    "deleted_users",
    "verification_results",
    "reference_samples",
    "sessions",
    "verification_seq",
    "login_failures",
    "login_lockouts",
    "audit_log",
]


def fetch_rows(sqlite_conn: sqlite3.Connection, table: str) -> list[sqlite3.Row]:
    cur = sqlite_conn.cursor()
    cur.execute(f"SELECT * FROM {table}")
    return cur.fetchall()


def column_names(sqlite_conn: sqlite3.Connection, table: str) -> list[str]:
    cur = sqlite_conn.cursor()
    cur.execute(f"PRAGMA table_info({table})")
    return [row["name"] for row in cur.fetchall()]


def copy_table(
    sqlite_conn: sqlite3.Connection,
    pg_conn,  # psycopg.Connection
    table: str,
) -> int:
    """Copy one table. Returns the number of rows inserted (skipping
    rows that conflict on the primary key)."""
    rows = fetch_rows(sqlite_conn, table)
    if not rows:
        logger.info("  %s: empty, skipping", table)
        return 0

    cols = column_names(sqlite_conn, table)
    placeholders = ", ".join(["%s"] * len(cols))
    column_list = ", ".join(cols)
    pkey = _primary_key_hint(table)
    on_conflict = f"ON CONFLICT ({pkey}) DO NOTHING" if pkey else "ON CONFLICT DO NOTHING"
    sql = f"INSERT INTO {table} ({column_list}) VALUES ({placeholders}) {on_conflict}"

    inserted = 0
    with pg_conn.cursor() as cur:
        for row in rows:
            values = tuple(row[c] for c in cols)
            try:
                cur.execute(sql, values)
                inserted += cur.rowcount or 0
            except Exception as exc:
                logger.error("  %s: row insert failed (%s); aborting", table, exc)
                pg_conn.rollback()
                raise
    pg_conn.commit()
    logger.info("  %s: %d / %d rows copied", table, inserted, len(rows))
    return inserted


def _primary_key_hint(table: str) -> str | None:
    """SQLite + Postgres schemas should match, so the PK column name on
    the SQLite side works as the conflict target. Encode the few cases
    explicitly so we don't have to introspect Postgres."""
    return {
        "users": "user_id",
        "deleted_users": "user_id",
        "verification_results": "result_id",
        "reference_samples": "sample_id",
        "sessions": "session_token",
        "verification_seq": "day",
        "login_lockouts": "user_id, ip",
        "audit_log": "event_id",
        # login_failures has no natural PK in the SQLite schema; use ON
        # CONFLICT DO NOTHING without a target (handled below).
        "login_failures": None,
    }.get(table)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sqlite", type=Path, required=True, help="Path to biovoice.sqlite3")
    parser.add_argument("--postgres-url", required=True, help="postgres://user:pass@host:port/db")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print row counts per table without writing to Postgres",
    )
    args = parser.parse_args()

    if not args.sqlite.exists():
        logger.error("SQLite database not found: %s", args.sqlite)
        return 2

    sqlite_conn = sqlite3.connect(str(args.sqlite))
    sqlite_conn.row_factory = sqlite3.Row

    if args.dry_run:
        logger.info("Dry-run — counting rows in %s", args.sqlite)
        for table in TABLES:
            try:
                rows = fetch_rows(sqlite_conn, table)
                logger.info("  %s: %d rows", table, len(rows))
            except sqlite3.OperationalError as exc:
                logger.warning("  %s: %s", table, exc)
        return 0

    try:
        import psycopg  # type: ignore
    except ImportError:
        logger.error("psycopg not installed. Run: pip install 'psycopg[binary]>=3.1'")
        return 2

    pg_conn = psycopg.connect(args.postgres_url)
    logger.info("Connected to Postgres; copying %d tables", len(TABLES))
    total = 0
    for table in TABLES:
        try:
            total += copy_table(sqlite_conn, pg_conn, table)
        except sqlite3.OperationalError as exc:
            logger.warning("  %s: SQLite read failed (%s); skipping", table, exc)
    logger.info("Done — %d rows inserted across %d tables", total, len(TABLES))
    pg_conn.close()
    sqlite_conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
