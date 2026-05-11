# Changelog

All notable changes to BioVoice. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the project follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [v1.0.3] — 2026-05-12

Real visualisations. Closes the last two "schematic" / "approx" surfaces in the operator console — the EmbeddingConstellation now plots real ReDimNet 192-d → PCA(3) projections of every enrolled profile (centroid + per-sample dispersion + live moving point), and the LiveFeatures panel now uses real DSP (autocorrelation pitch, Levinson-Durbin LPC formants, cycle-to-cycle jitter, VAD-gated SNR) instead of FFT-bin shortcuts and a `+18 dB` SNR offset.

### Added

- **`GET /users/embeddings`** — bulk dump of every profile's stored centroid + per-sample 192-d embeddings. No schema migration: `users.sample_embeddings_json` already existed.
- **`POST /embed`** — encoder-only pass for the constellation's live point. Decodes + trims + encodes; **does not** write to DB, call AASIST, or bump verification metrics. ~50–100 ms on M2 CPU.
- **`backend/app/services/verification.py:embed_only()`** — new method backing `/embed`.
- **`frontend/src/lib/pca.ts`** — pure-JS PCA (covariance + power iteration with deflation) for projecting 192-d → 3-d. ~140 LoC, no deps.
- **`frontend/src/lib/dsp.ts`** — pure-JS DSP: autocorrelation pitch, pre-emphasis + Hamming + Levinson-Durbin LPC + Durand-Kerner roots for formants, cycle-to-cycle jitter, VAD-gated SNR. ~210 LoC, no deps.
- **`frontend/src/hooks/useEmbeddingProjection.ts`** — fetches `/users/embeddings`, fits a 3-component PCA over centroids ∪ samples, exposes projected coords. Refits when the enrolment list changes.
- **`frontend/src/hooks/useLiveEmbedding.ts`** — slices the last 1.5 s of mic audio every 500 ms, posts to `/embed`, projects through the shared basis. Settings toggle `biovoice.constellation.liveOn` (default `true`); off = no requests + no live point.
- **`backend/tests/test_embeddings_route.py`** (8 cases): shape, empty case, no-PII fields, `/embed` returns 192-d, no DB write, 400 on empty / silent, encoder parity with the enrolment path.
- **`frontend/src/lib/pca.test.ts`** (4 cases): synthetic 3-cluster gaussian separates, eigenvalues monotone, mean projects to ~zero.
- **`frontend/src/lib/dsp.test.ts`** (10 cases): pitch on 220 / 110 Hz sines within ±2 Hz, silence + white noise return 0, formants on cascaded resonators within ±80 Hz, jitter zero on stable buffer, SNR within ±1 dB of computed truth.

### Changed

- **`useMicrophone`** now also maintains a 2-second Float32 ring buffer at the native sample rate (via ScriptProcessorNode). New API: `getRecentFloat(seconds)`. Powers both the constellation live point and the LiveFeatures DSP.
- **`EmbeddingConstellation`** — gutted the seeded geometry (`hash(profile.id)` cluster centres, `seedRandom()` Gaussian noise points, 90 background "noise" points, `Math.sin(t)` "comet"). Renders real PCA(3) coords now. Tooltip updated from "Schematic — cluster centres are deterministic per profile ID, not real ReDimNet projections" to "Real ReDimNet 192-d → PCA(3). Live point updates while mic is on."
- **`LiveFeatures`** — replaced FFT-bin peak picking + `+18 dB` SNR fudge with `dsp.ts` calls. Now also surfaces F2/F3 + a real cycle-to-cycle jitter %.
- **`console.jsx`** label: `(live mic · approx jitter)` → `(live mic)`. Constellation panel header: `VOICE EMBEDDING SPACE (schematic)` → `VOICE EMBEDDING SPACE`. Constellation footer: added a `LIVE · ON / OFF` toggle chip.

### Removed

- All `(schematic)` / `(approx jitter)` strings. `rg -i "schematic|approx jitter" frontend/src/` returns nothing.

### Verification

- Backend: `pytest -q -m "not slow"` → 112/112 (was 104, +8 new).
- Frontend: `vitest run` → 47/47 (was 32, +15 new).
- Bundle size: 80.71 KB gzipped (budget 90 KB; v1.0.2 was 70 KB → +10 KB for PCA + DSP + hooks).
- Smoke: `curl /users/embeddings` returns 192-d centroids; `POST /embed` returns 192-d embedding + `model_provenance.encoder == "redimnet_b5"`.

## [v1.0.2] — 2026-05-10

Real-dataset benchmarks landed. Closes the audit's calibration gap (F-4) with measured numbers + DET / ROC / score-histogram plots. Switched from the gated VoxCeleb1 + ASVspoof datasets to public alternatives (LibriSpeech test-clean + self-built `say`-spoof set) so the eval is reproducible without licence acceptance.

### Added

- **`backend/scripts/_plotting.py`**: shared DET / ROC / score-histogram plot writers (matplotlib + sklearn). Used by both bench scripts via `--plot-dir`.
- **`backend/scripts/make_libri_pairs.py`**: builds 8000-trial VoxCeleb-format pair file from LibriSpeech test-clean (40 speakers × 100 positives × 100 negatives, seeded for reproducibility).
- **`backend/scripts/make_spoof_eval.py`**: builds a 600-clip ASVspoof-format eval set from LibriSpeech bonafide + 8 macOS `say` voices.
- **`[bench]` extra in pyproject.toml** (matplotlib + scikit-learn + soundfile). Out of CI scope; operator installs locally with `pip install -e ".[model,bench]"`.
- **`backend/tests/test_bench_helpers.py`** (7 cases): plot writers produce valid PNGs, `compute_eer` / `compute_min_dcf` math sane.
- **`docs/paper/results/`**: real eval JSONs + plots. Per-utterance CSVs included.

### Measured

| Subsystem | Dataset | Result | Comparison |
|---|---|---|---|
| ReDimNet B5 speaker verification | LibriSpeech test-clean (8000 pairs) | **EER 0.90 %**, min-DCF 0.000372 | paper baseline 0.79 % on VoxCeleb1-O |
| AASIST anti-spoofing | LibriSpeech bonafide vs macOS `say` spoofs (600 clips) | **EER 29.0 %** | confirms the documented AASIST/`say` cross-distribution gap |

Both checkpoints' SHA-256s recorded in the JSON outputs so future runs prove the same weights. Wall time on M2 Mac mini: 12 min for 8000 trials, 49 s for 600 clips.

### Threshold calibration (analysis, no code change)

Both measured EER thresholds drifted > 0.05 from defaults but **neither was retuned**:

- `similarity_threshold`: measured 0.387 on LibriSpeech, kept at 0.75. LibriSpeech is studio audio; lowering to 0.387 risks production false-accepts on real-room mic input.
- `deepfake_threshold`: measured 0.977 on `say` spoofs (degenerate — AASIST scores them like bonafide), kept at 0.50. Right fix is better attack distribution (XTTS clones, deferred to v1.1).

Calibration history added to `docs/thresholds.md`.

### Changed

- Both bench scripts now take `--dataset-name` flag (controls JSON `dataset` field + plot subdir).
- Both bench scripts switched from `torchaudio.load` to `soundfile.read` (torchaudio 2.11 dropped its built-in loaders).
- `bench_eer_voxceleb.py` now handles FLAC alongside WAV (LibriSpeech ships FLAC).

### Docs

- `docs/benchmarks.md` rewritten with real numbers + embedded DET / ROC plots + reproduce-on-fresh-box runbook + honest disclaimers about the LibriSpeech-vs-VoxCeleb difference.
- `docs/remaining_work.md` G3 marked done.
- `Plan.md` switched from v1.0.1 audit-fix plan to v1.0.2 benchmarks plan.

### Known limitations carried forward

- Anti-spoofing EER 29 % is real and high — measured proof of the macOS-`say`-vs-AASIST gap. Not a regression; expected per the operator-guide caveat. Lifts when XTTS-v2 (Plan §S2) lands real cloning attacks.
- Numbers don't directly compare to published baselines (different test distributions). For a side-by-side comparison, swap in the gated datasets via the same scripts.

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
