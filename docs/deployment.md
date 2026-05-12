# Deployment guide

> **v1.1.0+**: ship the single Docker image at `Dockerfile` (repo root). FastAPI serves the React UI on port 8000 — no separate frontend container.
> **Pre-1.1.0**: the three-service `docker-compose.yml` stack (backend + nginx static + nginx TLS) is still present for the original kiosk topology — see "[Local Docker Compose](#local-docker-compose-legacy)" at the bottom.

The kiosk is auth-free by design. Operator-driven physical environment; see `docs/operator-guide.md` for day-to-day usage and `docs/hardware.md` for procurement specs.

---

## Build the image

```bash
git clone https://github.com/edenadiv/BioVoice-App.git
cd BioVoice-App
docker build -t biovoice:1.1.0 .
```

What you get: a ~1.66 GB image with the FastAPI backend + bundled React UI + ML weights baked in. CPU-only torch (no CUDA bloat). Runs as the `biovoice` non-root user.

Smoke locally before pushing anywhere:

```bash
docker run -p 8000:8000 -v biovoice-data:/app/backend/data biovoice:1.1.0
# In another shell:
curl http://localhost:8000/health           # {"status":"ok"}
curl http://localhost:8000/users/embeddings # []
open http://localhost:8000                  # kiosk UI
```

---

## Hosting paths

The image is provider-neutral. Pick the one your team already runs.

### Fly.io

Auto-TLS on `*.fly.dev`, free tier, single binary deploy.

`fly.toml` (commit at repo root, override the app name):

```toml
app = "biovoice"               # change to your unique app name
primary_region = "iad"

[build]
dockerfile = "Dockerfile"

[http_service]
internal_port = 8000
force_https = true
auto_stop_machines = false     # ML cold-start is slow; keep warm
auto_start_machines = true
min_machines_running = 1

[mounts]
source = "biovoice_data"
destination = "/app/backend/data"

[[vm]]
cpu_kind = "shared"
cpus = 2
memory_mb = 2048               # CPU torch needs ~1.5 GB at peak
```

Then:

```bash
fly launch --no-deploy         # if app doesn't exist; otherwise skip
fly volumes create biovoice_data --size 5 --region iad
fly deploy
```

### Render

Web Service → "Build & deploy from a Git repository":
- Runtime: Docker
- Dockerfile path: `./Dockerfile`
- Health check path: `/readyz`
- Disk: 5 GB at `/app/backend/data`
- Plan: "Standard" or larger (≥ 2 GB RAM for torch)

### Railway

```bash
railway init
railway up                    # picks up the Dockerfile
railway volume create --name data --mount-path /app/backend/data
```

Set the public domain in the Railway dashboard; HTTPS is automatic.

### Self-hosted VPS (DigitalOcean / Hetzner / your own)

A reverse proxy with auto-TLS is the simplest path. With **Caddy**:

```bash
docker run -d --name biovoice \
  -p 8000:8000 \
  -v biovoice_data:/app/backend/data \
  --restart unless-stopped \
  biovoice:1.1.0
```

`/etc/caddy/Caddyfile`:

```
biovoice.example.com {
    reverse_proxy localhost:8000
}
```

```bash
sudo systemctl reload caddy
```

Caddy fetches a Let's Encrypt cert automatically. No nginx config to maintain.

---

## Persistent data

The container stores SQLite + reference recordings under `/app/backend/data/`. Mount a volume there so a redeploy doesn't reset enrolled profiles. ML weights are baked into the image — no separate mount.

| Path | What | Volume? |
|---|---|---|
| `/app/backend/data/biovoice.sqlite3` | Profiles, verification log, daily seq counter | YES |
| `/app/backend/data/reference_samples/` | The original WAVs from each enrolment | YES |
| `/app/backend/models/aasist.pt` | AASIST checkpoint | NO (in image) |
| `/app/backend/models/redimnet_b5.pt` | ReDimNet B5 checkpoint | NO (in image) |
| `/app/frontend_dist/` | Built React bundle | NO (in image) |

---

## Environment variables (optional)

| Var | Default | Use |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allow-list. Set to your kiosk hostname in production: `CORS_ORIGINS=https://kiosk.example.com`. |
| `LOG_LEVEL` | `INFO` | Standard Python logging level. |
| `BIOVOICE_LOG_FORMAT` | `json` | Set `plain` for human-readable dev. |
| `BIOVOICE_FRONTEND_DIST` | `/app/frontend_dist` | Override only if you bind-mount a custom UI build over the baked one. |

---

## Health + readiness

| Check | Endpoint | Returns |
|---|---|---|
| Liveness | `GET /health` | `{"status":"ok"}` once the process is accepting requests |
| Readiness (deep) | `GET /readyz` | `{"ready":true,"checks":{database,aasist_weights,redimnet_weights}}` — 503 if SQLite is unreachable |
| Prometheus | `GET /metrics` | Standard exposition format |
| Operator summary | `GET /metrics/summary` | Compact JSON (verifications/sec, p50 latency, uptime) |

If weights are missing, `/readyz` reports a `models_note` and the backend falls back to its heuristic detector + encoder. Verification still works but accuracy degrades — production must serve real weights. (The image bakes them in, so this only happens if you mount over `/app/backend/models`.)

---

## Backup + restore

`deploy/backup.sh` produces a single `tar.gz` of the SQLite DB + reference samples. Run from the host that holds the data volume:

```cron
30 2 * * * /opt/biovoice/deploy/backup.sh
```

Default retention: 30 days; edit the script to change.

To restore: stop the container, `./deploy/restore.sh <archive>`, restart.

---

## TLS

The container itself speaks plain HTTP on :8000. Terminate TLS at the layer in front:

- **Fly.io / Render / Railway**: automatic, nothing to do.
- **VPS + Caddy**: automatic Let's Encrypt as shown above.
- **VPS + nginx**: see `deploy/nginx.conf` for a hardened reference (Mozilla intermediate profile, HSTS, edge rate limit). Drop your fullchain + privkey in `deploy/certs/`.
- **Closed network kiosk**: self-signed cert is fine; the operator accepts it once.

---

## PWA install

After the kiosk is reachable over HTTPS, end-users can install it as a Progressive Web App:

- iPhone Safari: Share → Add to Home Screen
- Android Chrome: menu → Install app
- Desktop Chrome / Edge: install icon in the URL bar

See `docs/pwa-install.md` for screenshots + quirks.

PWA install requires HTTPS (or `localhost`); HTTP-only LAN deployments won't surface the install prompt.

---

## Operational sanity

| Question | Command |
|---|---|
| Is the container alive? | `curl https://kiosk.example.com/health` |
| Is the deep stack ready? | `curl https://kiosk.example.com/readyz` |
| Verification throughput? | `curl https://kiosk.example.com/metrics/summary` |
| Container logs | `docker logs -f biovoice` (or your platform's log viewer) |
| Restart | `docker restart biovoice` (or platform-specific) |

---

## Postgres migration (still planned, deferred)

The current SQLite store is fine for single-instance deployments up to a few thousand enrolled users. Beyond that — or for multi-instance HA — migrate per `docs/postgres_migration.md`. The store layer is Protocol-based, so service code doesn't change; only the store implementation + container wiring.

---

## Hardening checklist

For closed-network single-kiosk deployments, the threat model is mostly local (operator misuse + physical access). For wider exposure:

- **TLS**: A+ on SSL Labs is the floor. The bundled `deploy/nginx.conf` aims for Mozilla "intermediate" profile; Caddy gets you the same automatically.
- **Body size**: nginx config limits multipart uploads to 10 MB. Verify on your reverse proxy.
- **Rate limit at the edge**: 50 r/s per IP, burst 100 in the bundled nginx config. Caddy's per-IP rate-limit plugin can do the same.
- **Auth**: the v1.0 strip removed cookie sessions because the kiosk was operator-controlled. If the kiosk becomes network-reachable beyond the operator console, **add an auth layer** — see `docs/remaining_work.md` G8.
- **Observability**: scrape `/metrics` into Prometheus; alert on `/readyz` 503 streaks.

---

## Local Docker Compose (legacy)

The original three-service stack is still in the repo for the local kiosk topology (backend + nginx static + nginx TLS). It uses `backend/Dockerfile` rather than the unified top-level one.

```bash
cd frontend && npm ci && npm run build && cd ..
docker compose up -d --build
curl --insecure https://localhost/readyz
```

Use this when you specifically want the host-published TLS-terminated nginx layout. For a hosted deploy, prefer the single-image path above.

---

## ML weights

The current image bakes both checkpoints in. To swap:
1. Replace `backend/models/aasist.pt` and/or `backend/models/redimnet_b5.pt` on the host.
2. Rebuild the image (`docker build -t biovoice:1.1.x .`).
3. Redeploy.

If you'd prefer to mount the weights at runtime (so updates don't require a rebuild), bind-mount over `/app/backend/models` and document the source-of-truth path on your infra.
