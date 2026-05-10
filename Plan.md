# BioVoice — Audit Fix Plan (v1.0.1)

> **Status**: drafted 2026-05-10 · responds to `docs/audit-v1.0.md` · single-kiosk Mac/Linux · branch `main`
> **Supersedes**: the v1.0 ship plan (kept in git history).

---

## Context

`docs/audit-v1.0.md` (committed `a2f5040`) ran a CEO-style due-diligence audit and surfaced eight findings (3 HIGH, 2 MEDIUM, 3 LOW). The pipeline is real but ships with three ways to mislead a buyer or an operator:

- **HIGH F-1**: AASIST silently falls back to a 3-line linear formula if `models/aasist.pt` is missing. `/readyz` surfaces it; `/verify` + `/spoof/test` return a `deepfake_score` with no provenance flag. The UI has no signal to differentiate.
- **HIGH F-2**: ReDimNet's `PlaceholderSpeakerEncoder` (8-d hash features) exists in `app/services/speaker_encoder.py:61`. Direct verification confirmed `container.py` wires `RedimNetSpeakerEncoder` only — so it raises on missing weights rather than falling back. The risk is **dead code that looks like a live fallback**; plus, anyone wiring the placeholder later would silently degrade. Wire it with a provenance flag.
- **HIGH F-5**: Zero backend pytest cases load the real ReDimNet/AASIST weights. Every test uses `HashEncoder` + `StubDetector` from `tests/conftest.py:58-115`. A regression in `RedimNetSpeakerEncoder.__init__` or `DeepfakeDetectorService.load()` would not be caught by CI.
- **MEDIUM F-3**: `analysis_details` (`voice_naturalness`, `spectral_consistency`, `temporal_patterns`, `artifact_detection`) are sigmoid-squashed acoustic features, not from AASIST. README + CHANGELOG disclose this; the API field name doesn't.
- **MEDIUM F-4**: Decision thresholds (`similarity_threshold=0.75`, `deepfake_threshold=0.50` in `app/core/config.py:40-41`) are uncalibrated guesses. No ROC curve, no operating-point rationale anywhere in the repo.
- **LOW F-6**: `EmbeddingConstellation` panel labelled `VOICE EMBEDDING SPACE · ● LIVE` (`frontend/src/console.jsx:492-493`) but plots `seedRandom(hash(user_id))`.
- **LOW F-7**: `LiveFeatures` panel labelled `EXTRACTED VOICE FEATURES · LIVE` (`frontend/src/console.jsx:470`) but jitter/shimmer source comment says `// simulated` (`console-ext.jsx:312`).
- **LOW F-8**: README cites bundle 73 KB + p50 ~400 ms; CI has a bundle budget of 350 KB (loose) and no latency assertion in the smoke.

Outcome: every operator-facing surface either tells the truth or carries a visible degradation flag. CI catches a regression that reverts to heuristics. Tag v1.0.1.

---

## Phase HF1 — Model-provenance flag (HIGH · closes F-1, F-2)

**Goal**: every score-bearing API response carries which engine produced it. The UI shows a visible banner when any subsystem is in heuristic-fallback mode.

### HF1.1 — Backend service-level provenance

- `backend/app/services/detector.py` `DeepfakeDetectorService` — add a `provenance` property (`"aasist"` when `self.model is not None`, `"heuristic"` otherwise). Populated lazily on first `load()`.
- `backend/app/services/speaker_encoder.py` `RedimNetSpeakerEncoder` — add `provenance: Literal["redimnet_b5"]` (always real; raises on missing weights). `PlaceholderSpeakerEncoder` returns `"heuristic_placeholder"` if anyone wires it.
- `backend/app/services/sub_classifier.py` `AcousticProbe` — add `provenance: Literal["heuristic", "trained_heads"]` based on `self.heads is not None`.

### HF1.2 — Schema (response payload)

- New `backend/app/schemas.py` class `ModelProvenance(BaseModel)`:
  ```python
  encoder: Literal["redimnet_b5", "heuristic_placeholder"]
  detector: Literal["aasist", "heuristic"]
  acoustic_probe: Literal["heuristic", "trained_heads"]
  is_degraded: bool  # true iff any of the three is a fallback
  ```
- Add `model_provenance: ModelProvenance` field to `VerificationResponse`, `IdentificationResponse`, `SpoofTestResponse`, `EnrollmentResponse` (encoder only matters here).

### HF1.3 — Service plumbing

- `backend/app/services/verification.py` — populate `model_provenance` in every response constructor via new `_collect_provenance()` helper.
- Same for `app/api/routes.py` `/spoof/test` route.

### HF1.4 — Frontend banner

- `frontend/src/types.ts` — `ModelProvenance` type.
- `frontend/src/lib/api.ts` — `toModelProvenance()` snake→camel transform; surface on every result helper.
- `frontend/src/components/DegradedBanner.tsx` (new) — red-tinted bar at the top of any result panel when `provenance.isDegraded === true`. Lists subsystems + restore action.
- Insert in: `console-ext.jsx` `ResultPanel`, `more-screens.jsx` `IdentifyResults` + DeepfakeLab result, `EnrollModal.tsx` per-sample row.

### HF1.5 — Tests

- `backend/tests/test_provenance.py` (new, ~5 cases): real weights → all-real, AASIST removed → detector=heuristic+is_degraded=true, field present on /verify+/identify+/spoof/test+/enroll.
- `frontend/src/lib/api.test.ts` (~2 cases): provenance shape on verify + identify.

## Phase HF2 — Real-model integration test (HIGH · closes F-5)

**Goal**: at least one CI test loads the real ReDimNet + real AASIST weights and runs end-to-end.

### HF2.1 — pytest `slow` marker

Add to `backend/pyproject.toml`:
```toml
[tool.pytest.ini_options]
markers = ["slow: real model load (skipped by default; run with -m slow)"]
```

### HF2.2 — The integration test

`backend/tests/test_real_models_integration.py`:
- `pytestmark = pytest.mark.slow`.
- Skip if weights missing or system TTS missing.
- Build real `RedimNetSpeakerEncoder` + `DeepfakeDetectorService`. Wire into real `VerificationService`.
- Generate WAV via `say` / `espeak-ng` (same approach as `deploy/smoke.sh`).
- Assert: enrol succeeds, verify returns sim ∈ [0.7, 1.0] with decision in {ACCEPT, DEEPFAKE}, `is_degraded === false`, all stage timings positive.

### HF2.3 — CI wiring

`.github/workflows/ci.yml` — new `backend-integration` job that runs `pytest -m slow`. Marked `continue-on-error: true` initially; tighten after green baseline. Document cache-key for model weights in `docs/qa.md`.

## Phase HF3 — `AnalysisDetails.mode` honesty flag (MEDIUM · closes F-3)

- `backend/app/schemas.py` `AnalysisDetails` — add `mode: Literal["heuristic", "trained_heads"]`.
- `backend/app/services/sub_classifier.py` — populate `mode` based on `self.heads is not None`.
- `frontend/src/more-screens.jsx` DeepfakeLab + verify-result panels — conditional label `ACOUSTIC FEATURES (heuristic v1.0)` vs `ACOUSTIC SUB-AXES (trained probe)`.
- Don't rename the `analysis_details` API field — mode flag is enough.

## Phase HF4 — Threshold documentation (MEDIUM · closes F-4)

- `backend/app/core/config.py` — extensive docstrings above `similarity_threshold` + `deepfake_threshold` defaults. Cite `docs/thresholds.md`.
- `docs/thresholds.md` (new): what each threshold gates, the decision logic at `verification.py:_decide()`, why the SDD defaults, how to tune (edit config + restart), FAR/FRR trade-off table.
- `docs/operator-guide.md` "When something looks wrong" section — pointer for "all verifications come back REJECT".

## Phase HF5 — UI label honesty (LOW · closes F-6, F-7)

- `frontend/src/console.jsx:492-493` — change `VOICE EMBEDDING SPACE · ● LIVE` → `VOICE EMBEDDING SPACE (schematic)`. Drop the LIVE chip.
- `frontend/src/console.jsx:470` — change `EXTRACTED VOICE FEATURES · LIVE` → `EXTRACTED VOICE FEATURES (live mic · approx jitter)` while recording, `(idle)` otherwise.

## Phase HF6 — Tighter CI assertions (LOW · closes F-8)

- `.github/workflows/ci.yml` — bundle budget 350 KB → 100 KB (current 76 KB; gives 24 KB headroom for HF1's banner + types).
- `deploy/smoke.sh` — parse `stage_breakdown.total_ms`; fail if > `BIOVOICE_LATENCY_BUDGET_MS` (default 800 ms).

## Phase HF7 — Operator runbook for fallback state (LOW · closes the F-1/F-2 user-facing piece)

`docs/operator-guide.md` "When something looks wrong" — new entries for the red banners HF1 introduces:
- "AASIST in heuristic fallback" → `models/aasist.pt` missing or torch not installed. Reinstall `[model]` extra.
- "Encoder in heuristic mode" → `models/redimnet_b5.pt` missing. Same fix.

## Phase HF8 — Release v1.0.1

- CHANGELOG.md entry covering all eight fixes.
- `docs/audit-v1.0.md` verdict footer noting which findings v1.0.1 closes.
- `git tag -a v1.0.1` + push.

---

## Critical files (paths to touch)

### Backend
- `backend/app/services/{detector.py, speaker_encoder.py, sub_classifier.py}` — `provenance` properties
- `backend/app/services/verification.py` — `_collect_provenance()` + response wiring
- `backend/app/api/routes.py` — provenance on `/spoof/test`
- `backend/app/schemas.py` — `ModelProvenance` class + `mode` on `AnalysisDetails`
- `backend/app/core/config.py` — threshold docstrings
- `backend/pyproject.toml` — `[tool.pytest.ini_options]` + slow marker
- `backend/tests/test_provenance.py` — new
- `backend/tests/test_real_models_integration.py` — new (slow-marked)

### Frontend
- `frontend/src/types.ts` — `ModelProvenance` type
- `frontend/src/lib/api.ts` — `toModelProvenance()` + surface on every result
- `frontend/src/components/DegradedBanner.tsx` — new
- `frontend/src/components/EnrollModal.tsx` — banner per sample row
- `frontend/src/console.jsx` — label edits + verify-result banner
- `frontend/src/console-ext.jsx` — `ResultPanel` banner
- `frontend/src/more-screens.jsx` — `IdentifyResults` banner + DeepfakeLab banner + AcousticProbe label
- `frontend/src/lib/api.test.ts` — 2 new provenance shape cases

### Docs
- `Plan.md` — this file
- `docs/thresholds.md` — new
- `docs/operator-guide.md` — fallback runbook + thresholds pointer
- `docs/qa.md` — slow-test gate documentation
- `docs/audit-v1.0.md` — verdict footer

### Ops
- `.github/workflows/ci.yml` — `backend-integration` job + tighter bundle budget
- `deploy/smoke.sh` — latency assertion

---

## Verification (run before tagging v1.0.1)

1. **Backend pytest fast**: `cd backend && .venv/bin/pytest -q -m "not slow"` → ≥ 93 pass (88 today + 5 new provenance).
2. **Backend pytest slow**: `cd backend && .venv/bin/pytest -m slow` → 1 case green when weights present.
3. **Frontend Vitest**: `cd frontend && npm test` → ≥ 32 pass (30 today + 2 new).
4. **Frontend bundle**: `cd frontend && npm run build` → ≤ 100 KB gzipped.
5. **Playwright**: `cd frontend && npx playwright test --project=chromium-desktop` → 8 pass (axe still clean with the new banner).
6. **End-to-end smoke**: `BIOVOICE_BACKEND=http://localhost:8000 ./deploy/smoke.sh` — passes including new latency assertion.
7. **Provenance smoke (manual)**: rename `models/aasist.pt` → restart → verify → `model_provenance.detector === "heuristic"` + UI banner. Restore → banner gone.
8. **Tag**: `git tag -a v1.0.1` + push.

---

## Effort summary

| Phase | Severity | Engineer-days |
|---|---|---|
| HF1 — Model provenance flag + UI banner | HIGH | 1.0 |
| HF2 — Real-model integration test + CI wiring | HIGH | 0.5 |
| HF3 — `analysis_details.mode` field + UI label | MEDIUM | 0.2 |
| HF4 — `docs/thresholds.md` + config docstrings | MEDIUM | 0.3 |
| HF5 — UI label honesty (Constellation + Features) | LOW | 0.1 |
| HF6 — Tighten CI budget + smoke latency check | LOW | 0.2 |
| HF7 — Operator-guide fallback runbook | LOW | 0.1 |
| HF8 — Release v1.0.1 | — | 0.2 |
| **Total** | — | **~2.5 engineer-days** |

Out of scope (deferred — already tracked):
- S2 (XTTS voice cloning) — v1.1.
- S7 (Tauri native installer) — v1.1.
- Real-dataset EER benchmarks — gated by operator dataset acquisition (S3 follow-on).
- Trained sub-classifier heads — research-grade work, v1.1+.
