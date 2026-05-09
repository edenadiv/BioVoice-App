# SQLite → Postgres migration plan (F7.1)

The current single-instance SQLite store works for the kiosk's design point (one operator console, < 10k enrolled users, < 100k verifications). Production-multi-instance + the Δ-1 audit gap require Postgres. This document is the migration plan.

## What survives unchanged

The Protocol-driven storage layer means **no service code changes** — only the store implementation and the container wiring:

- `app/services/verification.py` depends on `VerificationStore` Protocol.
- `app/services/auth.py` depends on `SessionStore` Protocol.
- `app/services/rate_limit.py` depends on `LoginRateLimitStore` Protocol.
- `app/services/audit.py` depends on `AuditStore` Protocol.

`SQLiteStore` implements all four. `PostgresStore` will implement the same surface; `core/container.py` picks based on the `DATABASE_URL` env var:

```python
if settings.database_url and settings.database_url.startswith("postgres"):
    store = PostgresStore(...)
else:
    store = SQLiteStore(...)
```

## Schema

Mirror the schema in `app/storage/sqlite_store.py:_ensure_schema`. Notable differences for Postgres:

- `audit_log.event_id` → `BIGSERIAL` (drop the SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`).
- `verification_seq` — use a real Postgres sequence per day (`CREATE SEQUENCE` on demand) instead of the upsert pattern.
- `users.embedding_json` / `sample_embeddings_json` → `JSONB` for indexability (the kiosk doesn't need to query inside the embedding today, but operators eventually want "find users with low sample count" and similar — JSONB makes that trivial).
- `sessions.session_token` → indexed `TEXT` (already indexed via PRIMARY KEY in SQLite; same in Postgres).
- `login_failures` partition by month or run a periodic prune job (the SQLite version relies on the rolling `attempted_at >= since` query which Postgres handles fine but bloats the table).

Use Alembic for migrations:

```bash
cd backend
alembic init migrations
alembic revision -m "0001_initial_schema"
# author the migration to match _ensure_schema, then:
alembic upgrade head
```

## Connection management

- Use `asyncpg` directly or `SQLAlchemy 2.x` async — both fine. `asyncpg` keeps the deps lighter; SQLAlchemy gives us schema migrations + the option to introspect.
- Pool size: 5–10 connections per backend instance. The kiosk's traffic is bursty (one operator, occasional verifications) so a small pool suffices.
- Enable statement timeouts at the connection level: `SET statement_timeout = '5s'` so a runaway query can't stall the whole event loop.

## Cutover playbook

1. **Bring up Postgres** in the same network as the backend. Apply the Alembic schema.
2. **Run the data copy script** while the backend is still serving from SQLite:
   ```bash
   .venv/bin/python scripts/migrate_sqlite_to_postgres.py \
       --sqlite ./backend/data/biovoice.sqlite3 \
       --postgres-url $DATABASE_URL
   ```
   This script (to be authored) walks every table in the SQLite store and bulk-inserts into Postgres. Idempotent — safe to re-run.
3. **Replay deltas** by running the script a second time during a brief maintenance window with the backend stopped (catches any rows written during the bulk copy).
4. **Flip the env var**: set `DATABASE_URL=postgres://…` and restart the backend. Verify `/readyz` passes (it should now report Postgres connectivity in the `database` check).
5. **Keep the SQLite file on disk** for at least 30 days as a rollback. After that, archive + delete.

## Per-test infrastructure

CI needs to exercise the Postgres path:

```yaml
# .github/workflows/ci.yml
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_PASSWORD: ci
    options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
```

Then in the test harness, choose the store via `DATABASE_URL`:

```bash
DATABASE_URL=postgres://postgres:ci@localhost:5432/biovoice pytest backend/tests/
```

Most existing tests use `MemoryStore` directly so they remain database-independent. The integration tests (which actually instantiate the SQLiteStore) get parameterised over the two backends — same test body, different store.

## Estimated effort

- `PostgresStore` implementation: 1–2 days for an engineer familiar with SQLAlchemy/asyncpg.
- Alembic setup + initial migration: 0.5 day.
- Data copy script + cutover playbook validation: 0.5 day.
- CI integration: 0.5 day.
- Total: ~3 engineer-days, plus a maintenance-window cutover.
