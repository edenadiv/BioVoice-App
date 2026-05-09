# Backend

FastAPI backend scaffold for the web version of BioVoice.

Current responsibilities:

- Audio upload and preprocessing
- Enrollment
- Verification
- Deepfake detection
- Result persistence

Implementation entrypoint:

- `app/main.py`

The backend currently uses in-memory storage and a feature-based speaker embedding placeholder so the web flow can be built before the final persistence and model-serving layer is added.

Installation:

- Base backend plus local model stack: `python -m pip install -e .[model] --no-build-isolation`
- Add spoof-generation support (XTTS): `python -m pip install -e .[model,spoof] --no-build-isolation`

Notes:

- The `spoof` extra depends on `TTS`, which is currently expected to work on Python 3.11 or 3.12.
- On Python 3.13, install the backend without `spoof` unless `TTS` publishes compatible builds.

## Environment variables

Every secret + every environment-specific value is read from `os.environ`.
Local dev: copy `backend/.env.example` to `backend/.env` and source it before
running `uvicorn`. Production: have your secret manager populate the env at
deploy time (see "Secrets management" below).

| Var | Purpose | Example |
|---|---|---|
| `CORS_ORIGINS` | Comma-separated list of allowed origins for browser CORS. Defaults to `http://localhost:5173`. Add the LAN IP for phone/iPad demos. | `CORS_ORIGINS=http://localhost:5173,http://10.0.0.10:5173` |
| `SESSION_IDLE_SECONDS` | F2.1 — rolling idle window for `/auth/session` and refresh. Default 1800 (30 min). | `SESSION_IDLE_SECONDS=1800` |
| `LOGIN_RATE_MAX_ATTEMPTS` | F2.2 — failures within `LOGIN_RATE_WINDOW_SECONDS` before lockout. Default 5. | `LOGIN_RATE_MAX_ATTEMPTS=5` |
| `LOGIN_RATE_WINDOW_SECONDS` | F2.2 — rolling window. Default 300 (5 min). | `LOGIN_RATE_WINDOW_SECONDS=300` |
| `LOGIN_LOCKOUT_SECONDS` | F2.2 — lockout duration once exceeded. Default 900 (15 min). | `LOGIN_LOCKOUT_SECONDS=900` |
| `BIOVOICE_ADMIN_API_KEY` | F2.4 / F6 — gates the `/admin/*` surface. Unset = admin endpoints disabled (default). Generate with `python -c "import secrets; print(secrets.token_urlsafe(32))"`. | `BIOVOICE_ADMIN_API_KEY=...` |
| `LOG_LEVEL` | Python `logging` level. F7.2 ships JSON logs by default; set `BIOVOICE_LOG_FORMAT=plain` for human-readable dev. | `LOG_LEVEL=INFO` |
| `BIOVOICE_LOG_FORMAT` | F7.2 — `json` (default) emits one JSON line per record; `plain` for local dev. | `BIOVOICE_LOG_FORMAT=plain` |
| `BIOVOICE_COOKIE_INSECURE` | F2.5 — set to `1` to drop the `Secure` flag on the session cookie so HTTP local dev (no TLS) works. Production must leave this **unset** so the cookie is HTTPS-only. | `BIOVOICE_COOKIE_INSECURE=1` |
| `DATABASE_URL` | F7.1 (planned) — Postgres connection string. Unset = SQLite at `backend/data/biovoice.sqlite3`. | `DATABASE_URL=postgres://…` |

## LAN-IP demos

To run the frontend from a phone / iPad on the same Wi-Fi:

```bash
CORS_ORIGINS=http://localhost:5173,http://10.0.0.10:5173 \
  .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then run the frontend with `--host 0.0.0.0 --port 5173` and open `http://10.0.0.10:5173/` from the phone (replacing `10.0.0.10` with your Mac's LAN IP, returned by `ipconfig getifaddr en0`).

## Secrets management (F2.4)

The backend never has hardcoded secrets. The `tests/test_secret_scan.py`
pytest scans the working tree on every CI run for high-confidence secret
signatures (AWS keys, GitHub tokens, Slack tokens, RSA/EC private keys,
Stripe live keys, etc.) and fails the build if any match. Try injecting a
fake key into a `.py` file under `backend/app/` and re-running the test —
it should fail with a precise `path:line` pointer.

**Workflow**

1. **Local dev** — copy `backend/.env.example` to `backend/.env`, fill in
   placeholders, then source it:
   ```bash
   set -a; source backend/.env; set +a
   .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```
2. **Cloud / production** — store secrets in **Doppler** (recommended) /
   1Password Secrets Automation / AWS Secrets Manager / HashiCorp Vault.
   Materialise them as env vars on the host before launching uvicorn:
   ```bash
   doppler run -- .venv/bin/uvicorn app.main:app
   ```
3. **Containers** — pass via `docker compose --env-file=.env` or k8s
   `envFrom: [secretRef:]`. Never bake secrets into the image.

**Rotation policy**

- `BIOVOICE_ADMIN_API_KEY`: rotate every 90 days or on operator change.
- Session tokens: rotate per refresh (F2.1) — automatic.
- Bearer tokens / API keys for ANY downstream service: 90 days or on suspected
  exposure, whichever comes first.

If a secret leaks, revoke it at the source first, then rotate the env, then
restart the service. The pre-commit secret-scan + the CI gate are
belt-and-braces — assume both can fail and have a recovery procedure.

## XTTS spoof generation (production)

`POST /me/spoof` uses XTTS-v2 to clone an enrolled voice. There is no
fallback path — install XTTS for real:

```bash
bash scripts/setup_xtts.sh                          # downloads XTTS-v2 weights into ../XTTS-v2/
.venv/bin/pip install 'TTS>=0.22,<0.23'             # XTTS Python deps
```

If `TTS` won't install on your Python version (3.13+ is currently unsupported by the upstream package), use a pinned 3.12 venv:

```bash
python3.12 -m venv .venv-xtts
.venv-xtts/bin/pip install -e '.[model,spoof]' --no-build-isolation
```
