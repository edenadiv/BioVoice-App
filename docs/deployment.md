# Deployment guide

> Single-kiosk Mac/Linux field deployment. No auth surface (operator-driven physical environment); see `docs/operator-guide.md` for day-to-day usage and `docs/hardware.md` for procurement specs.

## TL;DR

```bash
git clone https://github.com/edenadiv/BioVoice-App.git
cd BioVoice-App

# 1. Provision optional config
cp backend/.env.example backend/.env
# (edit if you need non-default CORS_ORIGINS or LOG_LEVEL)

# 2. Provision TLS certs (optional for closed-network kiosks)
mkdir -p deploy/certs
# drop fullchain.pem + privkey.pem here, OR use self-signed for closed networks

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
| `backend` | `biovoice-backend:latest` (built from `Dockerfile`) | internal :8000 | FastAPI app + SQLite + ReDimNet + AASIST |
| `frontend` | `nginx:1.27-alpine` | internal :80 | Static SPA bundle (Vite output from `frontend/dist`) |
| `nginx` | `nginx:1.27-alpine` | host :80 + :443 | TLS + HSTS + edge rate-limit |

All traffic flows in through `nginx` → `frontend` (for `/`) or `backend` (for `/api/*`, `/readyz`, `/healthz`). The backend container has no host-published port.

## Environment variables

The kiosk is auth-free by design (operator-driven physical environment). All env vars are optional with sensible defaults.

| Var | Default | Use |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allow-list for the browser. Set to your kiosk hostname in production: `CORS_ORIGINS=https://kiosk.example.com`. |
| `LOG_LEVEL` | `INFO` | Standard Python logging level. |
| `BIOVOICE_LOG_FORMAT` | `json` | F7.2 — `plain` for human-readable dev. |
| `DATABASE_URL` | (SQLite at `./data/biovoice.db`) | Reserved for the v1.1 Postgres migration (see below). |

See `backend/.env.example` for the canonical reference.

## TLS certificates

The `nginx` container expects the cert files at:

```
/etc/nginx/certs/fullchain.pem
/etc/nginx/certs/privkey.pem
```

Mounted from `./deploy/certs/` on the host. Three common provisioning paths:

1. **Let's Encrypt** with `certbot` on the host: `certbot certonly --standalone -d kiosk.example.com`, then symlink `/etc/letsencrypt/live/<domain>/{fullchain,privkey}.pem` into `./deploy/certs/`. Reload nginx after each renewal.
2. **Self-signed** for closed-network kiosks: `openssl req -x509 -newkey rsa:4096 -keyout privkey.pem -out fullchain.pem -days 825 -nodes -subj "/CN=biovoice-kiosk.local"`. The browser will prompt the operator to accept the cert once.
3. **Customer PKI**: drop their fullchain + key directly into `./deploy/certs/` and document the renewal cadence.

## ML weights

`backend/models/aasist.pt` (~1.2 MB) and `backend/models/redimnet_b5.pt` (~30 MB) are the production checkpoints.

- **Bake into the image**: add `COPY models /app/models` to the `Dockerfile` (rebuild on every weight update). Increases image size but simplifies deploys.
- **Mount at runtime** (default in `docker-compose.yml`): keep the weights on the host (or an object store) and mount as a read-only volume:

```bash
docker run --rm -v biovoice_biovoice-models:/models -v "$(pwd)/backend/models:/src" alpine \
    cp -a /src/. /models
```

If the weights are missing, `/readyz` reports `models_note` and the backend falls back to its heuristic detector + encoder. Verification still works but accuracy degrades — production must serve real weights.

## Spoof generation engine

The `/spoof` route uses the system text-to-speech as the default engine:
- macOS containers: `say` (bundled with the OS, no extra config)
- Linux containers: install `espeak-ng` via `apt-get install -y espeak-ng` in the Dockerfile (or use the macOS host directly)

XTTS-v2 voice cloning is **planned for v1.1** — see `Plan.md` §S2 for the migration steps (Py 3.12 venv switch + 1.8 GB checkpoint + docker-compose volume mount). The current kiosk's spoof verdicts on system-TTS audio are documented as a known limitation in `docs/operator-guide.md`.

## Operational checks

| Check | Command |
|---|---|
| Liveness | `curl https://kiosk.example.com/healthz` → `{"status":"ok"}` |
| Readiness (deep) | `curl https://kiosk.example.com/readyz` → `{"ready":true,"checks":{...}}` |
| Prometheus metrics | `curl https://kiosk.example.com/api/metrics` |
| Operator summary | `curl https://kiosk.example.com/api/metrics/summary` (powers the Console panel — same numbers visible in the UI) |

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

## Postgres migration (v1.1 — planned)

The current SQLite store is functional for single-instance deployments up to a few thousand enrolled users. Beyond that — or for a multi-instance HA setup — migrate to Postgres:

1. Implement `app/storage/postgres_store.py` against the existing `VerificationStore` Protocol.
2. Add `DATABASE_URL=postgres://…` env var; `core/container.py` chooses store based on the URL scheme.
3. Alembic migration that creates the schema documented in `app/storage/sqlite_store.py:_ensure_schema`.
4. Cutover: stop traffic, run `scripts/migrate_sqlite_to_postgres.py`, redeploy with `DATABASE_URL` set.

The Protocol-driven storage layer means no service code changes — only the store implementation and the container wiring. See `docs/postgres_migration.md` for the full playbook.

## Hardening checklist

For closed-network single-kiosk deployments, the threat model is mostly local (operator misuse + physical access). For wider exposure, revisit:

- File upload paths (`/enroll`, `/verify`, `/spoof`, `/spoof/test`) — multipart parser limits configured in nginx (10 MB body limit). Verify on your nginx version.
- TLS config — A+ on SSL Labs is the floor. The bundled `deploy/nginx.conf` aims for Mozilla "intermediate" profile.
- Rate-limit at the edge: 50 r/s per IP, burst 100, configured in `deploy/nginx.conf`.
- If the kiosk becomes network-reachable beyond the operator console, **add an auth layer** — the v1.0 strip removed cookie sessions because the kiosk was operator-controlled. See `docs/remaining_work.md` G8.
