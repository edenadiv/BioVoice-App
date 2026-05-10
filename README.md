# BioVoice

A single-kiosk voice-biometric authentication system. Enrol an operator's voice, verify it later, attempt deepfake attacks against the detector, all from a self-contained operator console. Real ReDimNet B5 speaker embeddings + real AASIST anti-spoofing, no mocks.

![status: v1.0](https://img.shields.io/badge/status-v1.0-blue) ![tests: 79 backend · 28 frontend · 7 e2e](https://img.shields.io/badge/tests-114%20green-brightgreen) ![bundle: 73 KB gzipped](https://img.shields.io/badge/bundle-73KB%20gzipped-lightgrey)

## Quick start

```bash
git clone https://github.com/edenadiv/BioVoice-App.git
cd BioVoice-App

# Production deploy (Docker)
docker compose up -d --build
curl --insecure https://localhost/readyz

# Local dev (two terminals)
cd backend  && .venv/bin/uvicorn app.main:app --reload --port 8000
cd frontend && npm install && npm run dev
# → http://localhost:5173
```

Run the end-to-end smoke against a live backend:

```bash
./deploy/smoke.sh
```

## What's in the box

- **Three-screen operator kiosk**: Console (run verification + activity feed), Profiles (enrol + delete), Deepfake Lab (forge a clone, score it through AASIST).
- **Real models**: vendored ReDimNet B5 (192-d speaker embedding) + vendored AASIST (anti-spoofing). Weights at `backend/models/`. End-to-end p50 verify ~400 ms on Apple silicon.
- **Real audio capture**: MediaRecorder + AnalyserNode in the browser (no AudioWorklet flakiness). Mic device picker, manual start/stop with no time limit, file-upload alternative (mp3/m4a/wav/ogg/flac → decoded in browser to 16 kHz mono WAV).
- **Real telemetry**: every number in the Console panel comes from the live `/api/metrics/summary` endpoint. No hardcoded "11ms / 62/s / 14d" decoration anywhere.
- **Spoof generation**: macOS `say` / Linux `espeak-ng` fallback ships today (real synthetic audio that goes through real AASIST scoring); XTTS-v2 voice cloning is a v1.1 upgrade path.

## Documentation

| Doc | Audience |
|---|---|
| [`docs/operator-guide.md`](docs/operator-guide.md) | Day-to-day usage walkthrough — enrol, verify, forge a deepfake, troubleshoot. |
| [`docs/deployment.md`](docs/deployment.md) | Production deploy via Docker — TLS provisioning, env vars, backup/restore, hardening. |
| [`docs/hardware.md`](docs/hardware.md) | Procurement spec — Mac mini M2 / Intel NUC / mic recommendation / cold-start timing. |
| [`docs/benchmarks.md`](docs/benchmarks.md) | Methodology + scripts for ReDimNet (VoxCeleb1-O EER) and AASIST (ASVspoof 2019 LA EER + min-tDCF). |
| [`docs/qa.md`](docs/qa.md) | 10-step QA protocol + axe accessibility checklist + Lighthouse perf budget. |
| [`docs/postgres_migration.md`](docs/postgres_migration.md) | Storage migration playbook (planned for v1.1 multi-instance HA). |
| [`docs/remaining_work.md`](docs/remaining_work.md) | What's open vs done — G-tasks. |
| [`Plan.md`](Plan.md) | The active shipping plan. |
| [`CHANGELOG.md`](CHANGELOG.md) | Per-version release notes. |

## Architecture

```
┌──────────────────┐  WAV upload   ┌────────────────────────┐
│  React + Vite    │ ────────────▶ │  FastAPI :8000         │
│  Console / Lab   │               │  ┌──────────────────┐  │
│  Profiles        │ ◀──────────── │  │ ReDimNet B5      │  │
│  MediaRecorder   │  decision +   │  │ AASIST           │  │
└──────────────────┘  metrics      │  │ AcousticProbe    │  │
       ▲                           │  │ AudioService VAD │  │
       │ TLS via nginx (prod)      │  └──────────────────┘  │
       │                           │  SQLite: profiles,     │
       └───────────────────────────│  results, audit trail  │
                                   └────────────────────────┘
```

## What's planned for v1.1

- **XTTS-v2 voice cloning** for the Deepfake Lab. The current macOS `say` fallback works but doesn't always trigger the AASIST detector — XTTS clones do. See `Plan.md` §S2.
- **Tauri native installer** (`.dmg` / `.msi` / `.deb`). Removes the Docker prerequisite for the kiosk operator. See `Plan.md` §S7.
- **Postgres storage**, multi-instance HA. See `docs/postgres_migration.md`.
- **Trained sub-classifier heads** for AASIST sub-axis scoring. Currently heuristic.

## Status by component

| Component | State |
|---|---|
| ReDimNet B5 speaker embedding | ✅ Real, vendored, end-to-end |
| AASIST anti-spoofing | ✅ Real, vendored, end-to-end |
| `/enroll` + `/verify` + `/users` + `/results` | ✅ Public REST surface, no auth |
| `/spoof` + `/spoof/test` | ✅ system-TTS fallback shipped; XTTS-v2 v1.1 |
| MediaRecorder browser capture | ✅ Live waveform / level meter / mic picker |
| Console real-time metrics | ✅ /api/metrics/summary → live values |
| Deepfake Lab clone-and-score | ✅ End-to-end with real AASIST |
| Backup / restore | ✅ `deploy/backup.sh` + `deploy/restore.sh` |
| Cross-browser sign-off | ⏭ Chrome ✅; Safari/Firefox/iOS/Android pending |
| Published EER on ASVspoof + VoxCeleb | ⏭ scripts ready, real run pending dataset acquisition |

## Tests

```bash
# Backend
cd backend && .venv/bin/pytest -q          # 79 tests

# Frontend unit
cd frontend && npm test                     # 28 tests

# Frontend e2e (chromium)
cd frontend && npx playwright test --project=chromium-desktop  # 7 tests
```

## Licence

MIT (vendored AASIST is also MIT, vendored ReDimNet weights are research-use; check `backend/app/vendor/*/LICENSE` before redistribution).
