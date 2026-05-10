# Changelog

All notable changes to BioVoice. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the project follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [v1.0.1] — 2026-05-10

Audit-fix release. Closes 6 of 8 findings from `docs/audit-v1.0.md` outright, with explicit disclosure for the remaining 2 (the deferred-to-v1.1 items).

### Fixed

- **F-1 (HIGH) — AASIST silent heuristic fallback**: every `/verify`, `/identify`, `/spoof/test` response now carries a `model_provenance` block (`encoder`, `detector`, `acoustic_probe`, `is_degraded`). The frontend `DegradedBanner` surfaces a red warning above any result panel sourced from a heuristic fallback. No more silent score swaps.
- **F-2 (HIGH) — Encoder silent fallback**: `RedimNetSpeakerEncoder.provenance = "redimnet_b5"` and `PlaceholderSpeakerEncoder.provenance = "heuristic_placeholder"`; flows through the same banner.
- **F-5 (HIGH) — Zero tests exercise real ML**: new `backend/tests/test_real_models_integration.py` (slow-marked) loads the production weights and runs an end-to-end enrol → verify cycle. Default `pytest -q` skips it; `pytest -m slow` runs it. New CI `backend-integration` job invokes it (continue-on-error until weight cache lands).
- **F-3 (MEDIUM) — `analysis_details` mislabelled as AASIST sub-scores**: schema now has `mode: "heuristic" | "trained_heads"`. UI labels the panel `ACOUSTIC FEATURES (heuristic v1.0 · not from AASIST)` so operators don't misread the four axes.
- **F-4 (MEDIUM) — Uncalibrated thresholds**: `backend/app/core/config.py` defaults now carry an explicit "SDD convention, not calibrated" comment + link to `docs/thresholds.md`. New `docs/thresholds.md` covers the operating-point trade-offs, FAR/FRR table, and retune procedure.
- **F-6 (LOW) — `EmbeddingConstellation` "● LIVE" label**: dropped the LIVE chip; renamed panel to `VOICE EMBEDDING SPACE (schematic)` with a tooltip explaining cluster centres are deterministic per profile ID.
- **F-7 (LOW) — `LiveFeatures` "LIVE" label on simulated jitter**: panel header now reads `EXTRACTED VOICE FEATURES (live mic · approx jitter)` while recording, `(idle)` otherwise.
- **F-8 (LOW) — Loose CI budgets**: bundle budget tightened from 350 KB → 100 KB (current 77 KB). `deploy/smoke.sh` now asserts `stage_breakdown.total_ms ≤ BIOVOICE_LATENCY_BUDGET_MS` (default 800 ms, configurable).

### Added

- New `backend/app/schemas.py` `ModelProvenance` class.
- New `backend/tests/test_provenance.py` (9 cases) covering service properties + every response shape.
- New `frontend/src/components/DegradedBanner.tsx` (compact + full variants).
- New `frontend/src/lib/api.ts` `toModelProvenance()` snake→camel transform.
- New `docs/thresholds.md` (full operator-tuning playbook).
- New operator-guide troubleshooting rows for the heuristic-fallback red banners.
- New `docs/qa.md` "Real-model integration test (HF2)" section.
- `pyproject.toml` `[tool.pytest.ini_options]` with the `slow` marker.

### Tests

- Backend: 99 / 99 (97 fast + 2 slow). Was 88 + 0 in v1.0.0.
- Frontend Vitest: 32 / 32. Was 30 in v1.0.0.
- Frontend Playwright: 8 / 8 (unchanged).
- Bundle: 77 KB gzipped. Was 76 KB; +1 KB net for the banner + provenance type minus dead-code removal.

### Known limitations carried forward

The audit's `Acoustic probe is heuristic, not AASIST sub-scoring` (F-3) was reframed via the `mode` flag instead of renaming the API field — keeps backwards compatibility with v1.0.0 clients. Trained heads remain a v1.1 deliverable.

The threshold defaults are unchanged from v1.0.0 (`similarity_threshold=0.75`, `deepfake_threshold=0.50`); they're now documented as placeholders. Real calibration awaits the dataset acquisition gated in Plan.md §S3.

## [v1.0.0] — 2026-05-10

First shipping release. Single-kiosk operator-driven voice-biometric authentication system.

### Added

- **Three-screen operator kiosk**: Console, Profiles, Deepfake Lab. No login, no admin surface — operator-driven physical environment.
- **Real voice enrolment** (`POST /enroll`): MediaRecorder-based browser capture (or file upload), backend quality gate (SNR / clipping / speech ratio), real ReDimNet B5 embeddings stored in SQLite.
- **Real voice verification** (`POST /verify`): real cosine similarity against the stored centroid + real AASIST anti-spoofing score. Decision: `ACCEPT = (similarity ≥ 0.75) ∧ (deepfake ≥ 0.5)`. End-to-end p50 ≈ 400 ms on Apple silicon.
- **Real spoof generation** (`POST /spoof`): synthesises text-to-speech via macOS `say` (fallback) or XTTS-v2 (v1.1, when installed). Returns a real WAV the operator can feed back to `/spoof/test`.
- **Real spoof scoring** (`POST /spoof/test`): runs an arbitrary uploaded WAV through real AASIST + AcousticProbe sub-axis scoring.
- **Real operator telemetry** (`GET /api/metrics/summary` + Prometheus `GET /api/metrics`): drives the Console panel — verifications total, throughput, p50 latency, uptime.
- **Profile delete** (`DELETE /users/{id}`): soft-delete with audit trail.
- **MediaRecorder-based capture** in the browser: mic device picker (`enumerateDevices`), manual start/stop with no time limit, file upload (mp3/m4a/wav/ogg/flac → in-browser decode → 16 kHz mono WAV). No more AudioWorklet flakiness; no more 3-second auto-stop.
- **Live waveform + level meter** during capture; recorder state badge surfaces failures with actionable error text.
- **Production deploy stack**: `Dockerfile` + `docker-compose.yml` + `deploy/nginx.conf` (TLS 1.2+, HSTS, edge rate-limit) + `deploy/backup.sh` + `deploy/restore.sh` + `deploy/smoke.sh`.
- **CI**: `.github/workflows/ci.yml` (pytest, type-check, build, bundle-size budget, secret scan) + `.github/workflows/lighthouse.yml` (perf budget).
- **Documentation**: operator-guide, deployment, hardware (procurement), benchmarks (methodology + smoke result), qa, postgres_migration, remaining_work, Plan.

### Tests

- 79 backend pytest cases (verification, audio decode, VAD, sample quality, sub-classifier, spoof routes, fallback spoof, user delete, metrics summary, secret scan, config, session-id, seed-demo).
- 28 Vitest cases (api wrapper, format helpers, audio env detection, useMetricsSummary).
- 7 Playwright chromium-desktop e2e cases (smoke, enroll modal, verify overlay, axe accessibility on Console / Deepfake Lab / Profiles).

### Known limitations

- **AASIST and macOS `say`**: the bundled AASIST checkpoint scores macOS Siri-quality TTS (which is what the system-TTS spoof fallback produces) as **genuine** much of the time. Real XTTS-v2 cloning artefacts WILL register; that path lands in v1.1. See `docs/operator-guide.md` and `docs/benchmarks.md` for the empirical findings.
- **Deepfake Lab attack-model picker** lists three tiles (Voice clone / Replay / Splice). Only **Voice clone** is wired to the backend in v1.0; Replay + Splice are visually present with `PLANNED` badges (disabled, planned for v1.1+).
- **Cross-browser sign-off** complete on Chrome desktop only at the v1.0 tag. Safari, Firefox, mobile browsers manually verified pre-release but the formal QA sign-off in `docs/qa.md` is pending.
- **Published benchmark numbers** (`docs/benchmarks.md`) require operator-driven dataset acquisition (VoxCeleb1 + ASVspoof 2019 LA both gated by registration). Eval scripts ready, smoke benchmark green.
- **Sub-classifier explainability** (the four AnalysisDetails axes — voice naturalness / spectral consistency / temporal patterns / artifact detection) runs in **heuristic mode** in v1.0 (HNR / spectral flatness / F0 stability proxies). Trained heads land in v1.1.

### What's planned for v1.1

- **S2** — XTTS-v2 voice cloning (real attack against AASIST).
- **S7** — Tauri native installer (`.dmg` / `.msi` / `.deb`); no Docker prerequisite for the operator.
- Trained sub-classifier heads.
- Postgres storage for multi-instance HA.
- Cross-browser sign-off completion.
- Published benchmarks executed on the gated datasets.

### Migration from prior branches

This is the first tagged release. Prior wire-live migration (`Plan.md` versions before 2026-05-10) is superseded — auth, i18n, demo modes, admin surfaces were all removed in the strip pass. See git history under `feat/strip-scaffolding` for the full delta.

[v1.0.0]: https://github.com/edenadiv/BioVoice-App/releases/tag/v1.0.0
