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

| Var | Purpose | Example |
|---|---|---|
| `CORS_ORIGINS` | Comma-separated list of allowed origins for browser CORS. Defaults to `http://localhost:5173` when unset. Add the LAN IP for phone/iPad demos. | `CORS_ORIGINS=http://localhost:5173,http://10.0.0.10:5173` |

## LAN-IP demos

To run the frontend from a phone / iPad on the same Wi-Fi:

```bash
CORS_ORIGINS=http://localhost:5173,http://10.0.0.10:5173 \
  .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then run the frontend with `--host 0.0.0.0 --port 5173` and open `http://10.0.0.10:5173/` from the phone (replacing `10.0.0.10` with your Mac's LAN IP, returned by `ipconfig getifaddr en0`).

## XTTS spoof generation (production)

`POST /me/spoof` uses XTTS-v2 to clone an enrolled voice. There is no fallback — install XTTS for real:

```bash
bash scripts/setup_xtts.sh                          # downloads XTTS-v2 weights into ../XTTS-v2/
.venv/bin/pip install 'TTS>=0.22,<0.23'             # XTTS Python deps
```

If `TTS` won't install on your Python version (3.13+ is currently unsupported by the upstream package), use a pinned 3.12 venv:

```bash
python3.12 -m venv .venv-xtts
.venv-xtts/bin/pip install -e '.[model,spoof]' --no-build-isolation
```
