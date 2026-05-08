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
| `BIOVOICE_SEED_DEMO` | When set to `1`, populates the SQLite store with two bundled demo users (`alice_demo`, `bob_demo`) on startup if the store is empty. Idempotent. Off by default — production runs see an honest empty state. | `BIOVOICE_SEED_DEMO=1` |
| `BIOVOICE_FALLBACK_SPOOF` | When set to `1` and the XTTS dependencies/weights are unavailable, `POST /me/spoof` returns the bundled `data/fallback_spoof.wav` instead of HTTP 503. Lets the DeepfakeLab demo work without XTTS. | `BIOVOICE_FALLBACK_SPOOF=1` |

## LAN/phone demos

To demo from a phone or iPad on the same Wi-Fi:

```bash
CORS_ORIGINS=http://localhost:5173,http://10.0.0.10:5173 \
  .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Then run the frontend with `--host 0.0.0.0 --port 5173` and open `http://10.0.0.10:5173/` from the phone (replacing `10.0.0.10` with your Mac's LAN IP, returned by `ipconfig getifaddr en0`).

## Demo data seeding

```bash
BIOVOICE_SEED_DEMO=1 .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The `alice_demo` and `bob_demo` profiles will appear with `sampleCount: 3` in the kiosk Profiles page immediately. Removes the "Enrol your first speaker" empty state for client visits without anyone speaking into the mic first.

## XTTS spoof generation

The `/me/spoof` route uses XTTS-v2 to clone an enrolled voice. Set up:

```bash
bash scripts/setup_xtts.sh                          # downloads XTTS-v2 weights into ../XTTS-v2/
.venv/bin/pip install 'TTS>=0.22,<0.23'             # XTTS Python deps
```

If XTTS is unavailable on the machine, set `BIOVOICE_FALLBACK_SPOOF=1` to make the endpoint serve a bundled fallback WAV instead of returning 503. Useful for laptops without GPU / TTS deps.
