# Deployment guide (F7)

## TL;DR

```
git clone https://github.com/edenadiv/BioVoice-App.git
cd BioVoice-App

# 1. Provision secrets
cp backend/.env.example backend/.env
# edit backend/.env — at minimum set BIOVOICE_ADMIN_API_KEY

# 2. Provision TLS certs
mkdir -p deploy/certs
# drop fullchain.pem + privkey.pem here

# 3. Build the frontend
cd frontend && npm ci && npm run build && cd ..

# 4. Stand up the stack
docker compose up -d --build

# 5. Verify
curl --insecure https://localhost/readyz
```

The full kiosk should now be reachable at `https://<host>/`.

## Stack overview

| Component | Image | Port | Purpose |
|---|---|---|---|
| `backend` | `biovoice-backend:latest` (built from `Dockerfile`) | internal :8000 | FastAPI app + SQLite |
| `frontend` | `nginx:1.27-alpine` | internal :80 | Static SPA bundle |
| `nginx` | `nginx:1.27-alpine` | host :80 + :443 | TLS + HSTS + edge rate-limit |

All traffic flows in through `nginx` → `frontend` (for `/`) or `backend` (for `/api/*`, `/readyz`, `/healthz`). The backend container has no host-published port.

## Required environment variables

See `backend/.env.example` for the full list. The non-defaultable ones:

| Var | Why |
|---|---|
| `BIOVOICE_ADMIN_API_KEY` | Gates the `/admin/*` surface (F6). Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. Without this, every admin route returns 503. |
| `CORS_ORIGINS` | Comma-separated allow-list for the browser. Must include the public URL — e.g. `CORS_ORIGINS=https://kiosk.example.com`. |

Optional but commonly set:

| Var | Default | Use |
|---|---|---|
| `SESSION_IDLE_SECONDS` | 1800 | F2.1 — session lifetime. |
| `LOGIN_RATE_MAX_ATTEMPTS` / `_WINDOW_SECONDS` / `LOGIN_LOCKOUT_SECONDS` | 5 / 300 / 900 | F2.2 — brute-force gate. |
| `LOG_LEVEL` | INFO | Standard Python logging level. |
| `BIOVOICE_LOG_FORMAT` | json | F7.2 — `plain` for human-readable dev. |
| `BIOVOICE_COOKIE_INSECURE` | unset | F2.5 — drop `Secure` cookie flag for HTTP local dev. **Never set in production.** |

## TLS certificates

The `nginx` container expects the cert files at:

```
/etc/nginx/certs/fullchain.pem
/etc/nginx/certs/privkey.pem
```

Mounted from `./deploy/certs/` on the host. Three common provisioning paths:

1. **Let's Encrypt** with `certbot` on the host: `certbot certonly --standalone -d kiosk.example.com`, then symlink `/etc/letsencrypt/live/<domain>/{fullchain,privkey}.pem` into `./deploy/certs/`. Reload nginx after each renewal.
2. **Managed cert from the cloud vendor**: terminate TLS at the cloud LB (ALB / Cloud Load Balancer / Front Door) instead of in the `nginx` container. The compose setup keeps the per-host nginx config for HSTS + rate limit even when TLS termination is upstream.
3. **Customer PKI**: drop their fullchain + key directly into `./deploy/certs/` and document the renewal cadence.

## ML weights

`backend/models/aasist.pt` and `backend/models/redimnet_b5.pt` are large binaries (~150 MB each) and are **not** committed to the repo. The container expects them at `/app/models/`. Two ways to provision:

1. **Bake into the image** — add `COPY models /app/models` to the Dockerfile (rebuild on every weight update). Increases image size but simplifies deploys.
2. **Mount at runtime** — keep the weights on the host (or an object store) and mount as a read-only volume. The compose file ships option 2 by default; populate the `biovoice-models` named volume:

```bash
docker run --rm -v biovoice_biovoice-models:/models -v "$(pwd)/backend/models:/src" alpine \
    cp -a /src/. /models
```

If the weights are missing, `/readyz` reports `models_note` and the backend falls back to its heuristic detector + encoder. Verification still works but accuracy degrades — production must serve real weights.

## Operational checks

| Check | Command |
|---|---|
| Liveness | `curl https://kiosk.example.com/healthz` → `{"status":"ok"}` |
| Readiness (deep) | `curl https://kiosk.example.com/readyz` → `{"ready":true,"checks":{...}}` |
| Prometheus metrics | `curl https://kiosk.example.com/api/metrics` |
| Audit log | `curl -H "X-Admin-API-Key: $KEY" https://kiosk.example.com/api/admin/audit?limit=20` |

### What `/readyz` checks

1. SQLite connection (`SELECT 1`).
2. `aasist.pt` exists on disk.
3. `redimnet_b5.pt` exists on disk.

Returns 503 if (1) fails. Missing weights are reported as a `models_note` but **do not** fail the readiness probe — the heuristic fallback keeps the kiosk operational. Tighten this when your deployment cannot accept that fallback.

## Backup + restore

`./deploy/backup.sh` produces a single `tar.gz` containing the SQLite DB + reference samples. Run from cron:

```cron
30 2 * * * /opt/biovoice/deploy/backup.sh
```

Retention: 30 days, configurable inside `backup.sh`.

To restore: stop the backend, run `./deploy/restore.sh <archive>`, restart. Existing data is moved aside (not deleted) so the restore is reversible.

## Postgres migration (F7.1 — planned)

The current SQLite store is functional for single-instance deployments up to a few thousand enrolled users. Beyond that — or for a multi-instance HA setup — migrate to Postgres:

1. Implement `app/storage/postgres_store.py` against the existing `VerificationStore` Protocol (and the rate-limit / session / audit Protocols added in F2 / F6).
2. Add `DATABASE_URL=postgres://…` env var; `core/container.py` chooses store based on the URL scheme.
3. Alembic migration that creates the schema documented in `app/storage/sqlite_store.py:_ensure_schema`.
4. Cutover: stop traffic, `pg_dump` the SQLite via `sqlite3 → CSV → COPY` script (commit under `scripts/migrate_sqlite_to_postgres.py`), redeploy with `DATABASE_URL` set.

The Protocol-driven storage layer means no service code changes — only the store implementation and the container wiring.

## Pentest scope (F9.4)

When booking the pentest, scope:

- `/auth/login` (F2.2 rate limit, F2.5 cookie auth) — brute-force, replay, session fixation.
- `/admin/*` (F6) — admin-key bypass, IDOR on user delete, threshold-update race.
- `/me/*` (F2.5 cookie auth) — CSRF (despite SameSite=Strict), cookie theft via XSS.
- File upload paths (`/enroll`, `/verify`, `/me/spoof`) — multipart parser exploits, file-content tricks.
- TLS config — A+ on SSL Labs is the floor.

Provide the pentester with a fresh `BIOVOICE_ADMIN_API_KEY` and a non-admin enrolment account.
