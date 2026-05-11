# BioVoice v1.0 — Due-Diligence Audit

> **Frame**: read this as a CEO considering buying this product. Marketing claims are challenged against code reality. No softening. Findings cite `file:line`.
> **Auditors**: three parallel codebase walks (ML pipeline / UI / tests-and-claims) plus direct verification (model checkpoint introspection, route probing, fixture inspection).
> **Scope**: tag `v1.0.0` (`fdd481f`) and the post-tag commits on `main` through `b30af91`.
> **Date**: 2026-05-10.

---

## TL;DR

**You can buy this. You should not believe everything in the marketing.**

The ML pipeline is real and runs. The frontend mostly tells the truth. **But:**
- **Zero backend tests exercise the real ML.** All 88 pytest cases run against `HashEncoder` (8-d hash, not 192-d ReDimNet) + `StubDetector` (hardcoded score, not AASIST).
- **Silent heuristic fallbacks activate if weights are missing.** Operators learn this from `/readyz` only — the `/verify` response gives them a deepfake score with no flag indicating it came from a 3-line linear formula instead of AASIST.
- **The two production thresholds (similarity 0.75, deepfake 0.50) are guesses.** Never calibrated against any dataset. Document acknowledges this implicitly; UI never warns.
- **The "0.79 % EER" + "0.83 % EER" numbers in the model panel are paper baselines, not measured.** `docs/benchmarks.md` correctly marks the actual-measurement rows as `_pending_`. The README's "p50 ~400 ms" is a single-shot dev-machine measurement, not a benchmark.
- **Two visualisations look like data but aren't.** `EmbeddingConstellation` plots `seedRandom(hash(user_id))`, not real 192-D embeddings. `LiveFeatures` jitter/shimmer is "simulated" (per source comment), not real DSP.

What works as advertised:
- Audio capture (MediaRecorder + AnalyserNode)
- VAD + sample-quality gate (real signal processing, not ML, never claimed otherwise)
- `/metrics/summary` real telemetry driving the Console panel
- `/identify` ranks against real centroids
- Spoof generation produces real synthetic audio

---

## What's actually real ML

| Subsystem | Verdict | Evidence |
|---|---|---|
| **ReDimNet B5 speaker encoder** | ✅ REAL ML | `app/services/speaker_encoder.py:25-40`. Vendored `app/vendor/redimnet/`. Loads `models/redimnet_b5.pt` (31 MB, 1052 tensors, **7.7 M params**, `embed_dim=192` per checkpoint config). Strict `load_state_dict` — raises on mismatch. Forward pass is `torch.inference_mode()` → `model(inputs)`. **No tricks.** |
| **AASIST anti-spoofing detector** | ✅ REAL ML *(when weights load)* | `app/services/detector.py`. Vendored `app/vendor/aasist/`. Loads `models/aasist.pt` (1.2 MB, 229 tensors, **299,550 params**). The 1.2 MB is **not suspicious** — AASIST is a deliberately small graph-attention model; the published checkpoint is in this size class. |
| **Audio decode + VAD + quality gate** | ✅ REAL DSP *(not ML, never claimed to be)* | `app/services/audio.py:120-292`. Real `wave` decoding, frame-energy + zero-crossing VAD, frame-percentile SNR, plateau-detection clipping. Honest engineering. |
| **`/verify`, `/enroll`, `/identify` decision logic** | ✅ REAL | `app/services/verification.py`. Real cosine sim, real embedding aggregation, real threshold comparison. Nothing faked. |
| **`/spoof` system-TTS fallback** | ✅ REAL synthesis | `app/services/spoof.py:_generate_with_system_tts`. Calls real `say` (macOS) / `espeak-ng` (Linux). Audio is genuine TTS output. The header `X-Spoof-Source` tells the operator which engine ran. |
| **`/metrics/summary`** | ✅ REAL | `app/core/metrics.py`. Real Prometheus histogram, real percentile derivation, real wall-clock uptime since module import. |

**Bottom line**: when the system is healthy, every operator-facing decision is real model output.

---

## What's pseudoscience or fake

### F-1. AASIST silent heuristic fallback
**Severity: HIGH.** Honest at the readiness layer, dishonest at the API layer.

`app/services/detector.py:50` — if weights fail to load (missing file, torch missing, module import error), `self.model = None` and `detect()` returns `_heuristic_score()` instead. That heuristic is three lines:

```python
activity = min(1.0, mean_abs / 0.08)          # peak/mean threshold
stability = 1.0 - min(1.0, peak / 0.35)        # canned constants
return 0.15 + (activity * 0.45) + (stability * 0.4)
```

This is **pseudoscience**. It produces a number in `[0, 1]` with no relationship to the real anti-spoofing decision boundary.

`/readyz` (`app/api/routes.py:90`) DOES surface `aasist_weights.ok: false` + a `models_note` string. **`/verify` and `/spoof/test` do not.** They return a `deepfake_score` with no provenance flag. The frontend has no signal that it's looking at a heuristic instead of AASIST.

**Recommendation**: add a `model_provenance` field to `VerificationResponse` + `SpoofTestResponse` (`"aasist"` / `"heuristic"`) so the UI can warn.

### F-2. ReDimNet silent heuristic fallback
**Severity: HIGH.** Same shape as F-1.

`app/services/speaker_encoder.py:60-95` — `PlaceholderSpeakerEncoder` (an 8-dim hand-crafted feature vector: RMS, peak, ZCR, spread, percentiles) replaces the real model when weights are missing. The verification pipeline blends an 8-d "embedding" through cosine similarity and reports it as if it were a 192-d ReDimNet vector. Same operator-blind degradation.

**Recommendation**: same as F-1, plus consider a `503` from `/verify` when the encoder is in placeholder mode (operators arguably should not be doing identity decisions on hash features).

### F-3. AcousticProbe four-axis "AASIST sub-classifier"
**Severity: MEDIUM.** Misleading name, honest implementation.

`app/services/sub_classifier.py`. The four `analysis_details` axes (`voice_naturalness`, `spectral_consistency`, `temporal_patterns`, `artifact_detection`) **do not come from AASIST**. They come from sigmoid-squashed acoustic features (HNR, F0 stability, spectral flatness). Per-axis formulas like:

```python
voice_naturalness = 0.6 * sigmoid(hnr_db, centre=8.0) + 0.4 * voiced_norm
```

The README + CHANGELOG.md call this "heuristic mode" + "trained heads in v1.1" — that disclosure is honest. **The `console.jsx` SettingsPanel previously listed these as a separate model "TCAV STAGE-4" — that was fake and was removed in S1.** ✓ Good catch in the strip.

**Today's risk**: a casual reader of `analysis_details` in the API response or the DeepfakeLab UI would assume these are model-derived sub-scores. They are hand-tuned formulas in a sigmoid suit.

**Recommendation**: rename the schema field (`heuristic_details`?) or label the UI panel (`acoustic features (heuristic v1.0)`).

### F-4. Decision thresholds are uncalibrated guesses
**Severity: MEDIUM.** Documented nowhere.

`backend/app/core/config.py:40-41`:
```python
similarity_threshold: float = 0.75
deepfake_threshold: float = 0.50
```

There is **no document** in the repo justifying these values. No ROC curve, no FAR/FRR trade-off analysis, no operating-point selection rationale. They are convention defaults from the SDD that nobody tested against real audio.

**Why this matters**: at the wrong threshold, the system has either too many false accepts (security failure) or too many false rejects (operator unusability). Without calibration, **you don't know** which side of the trade-off this kiosk lands on.

**Recommendation**: until S3 is run on real ASVspoof + VoxCeleb, treat these as placeholders. Surface them in the operator-guide as tuning knobs and document the user-visible impact of moving them.

### F-5. Tests do not exercise real ML — they exercise stubs
**Severity: HIGH.** "88 tests passing" creates false confidence.

`backend/tests/conftest.py:58-115` defines `HashEncoder` (8-d sha256-derived "embedding") and `StubDetector` (returns a hardcoded float). The `verification_service` fixture (`conftest.py:118-131`) wires both. **Every backend pytest case** that uses this fixture exercises the stubs, not `RedimNetSpeakerEncoder` / `DeepfakeDetectorService`.

Search for the real classes in tests:
```bash
$ grep -lE "RedimNetSpeakerEncoder|DeepfakeDetectorService.*weights" backend/tests/
(no results)
```

**Zero backend tests load the real model weights.**

The bench scripts (`backend/scripts/bench_eer_voxceleb.py`, `bench_spoof_detection.py`) DO use the real classes — but they require gated datasets (VoxCeleb1 + ASVspoof 2019 LA, both behind registration walls) that have **never been acquired or run** for this codebase. The README/Plan/CHANGELOG correctly mark them as `_pending_`.

The only thing that proves the real ML pipeline works end-to-end is the **manual smoke** — `deploy/smoke.sh` and direct `curl` calls against a live backend, which I ran during this audit and which produced real ACCEPT/REJECT decisions with real similarity / deepfake scores.

**Recommendation**: add a single integration test marked `@pytest.mark.slow` that loads the real weights, runs an enrol → verify cycle on a fixture WAV, and asserts the response shape + score range. Without this, a future regression in the model-loading code path will not be caught by CI.

### F-6. `EmbeddingConstellation` is decorative, labelled "VOICE EMBEDDING SPACE · ● LIVE"
**Severity: LOW.** Honest in intent, easy to misread.

`frontend/src/console-ext.jsx:87-114`. Cluster centres are `seedRandom(hash(profile.id))`, point clouds are noise around centres. The "live voice comet" orbits via `Math.sin(t)` and audio level — not real cosine distance against any centroid.

The agent who reviewed this filed it as "decorative, honest about intent" — and that's fair. The visualisation does not promise real embeddings; the kiosk operator would understand it as schematic. **But** the panel label `VOICE EMBEDDING SPACE · ● LIVE` could be read as "this is showing my real voice in 192-D embedding space right now." It isn't.

**Recommendation**: change the badge to `(schematic)` or remove the `● LIVE` indicator on this panel specifically.

### F-7. `LiveFeatures` jitter / shimmer / SNR are approximations
**Severity: LOW.** Source comment is honest; UI panel doesn't disclose.

`frontend/src/console-ext.jsx:312` literally says `// simulated`. Jitter/shimmer are computed from running statistics over the level history, not from the standard period-to-period perturbation analysis a real DSP library would compute.

**Recommendation**: rename the panel from `EXTRACTED VOICE FEATURES · LIVE` to something with a "(approx)" tag, or fix the math to be real.

### F-8. Bundle-size + cold-start claims are not measured in CI
**Severity: LOW.** Bookkeeping, not deception.

README.md cites "bundle 73 KB gzipped" and the v1.0.0 tag commit logs "p50 ~400 ms". Neither is asserted in CI. The bundle size could drift up by 50 % over time without anything failing; the latency claim is a one-shot dev-machine measurement.

**Recommendation**: assert the bundle-size budget in `frontend/package.json` build script or in CI. Add the latency measurement to `deploy/smoke.sh` and tag it as the canonical reference number.

---

## What's labelled real but is honestly cosmetic

These deserve a separate category — the code or docs say "decorative" but the operator may not pick that up.

| Item | File | Status |
|---|---|---|
| `EmbeddingConstellation` | `console-ext.jsx:77-271` | Seeded random — operator may misread "VOICE EMBEDDING SPACE · LIVE" |
| `LiveFeatures` jitter/shimmer | `console-ext.jsx:312` | Comment says simulated; panel label doesn't |
| `ParticleFlow`, `AmbientField`, `ScanRings`, `VoiceOrb` | `visuals.jsx`, `console-ext.jsx`, `more-screens.jsx` | Pure backdrop chrome — honest, no operator could read these as data |
| `useSilentAudio` | `audio.jsx:189-199` | **Honest fix.** Was previously `useSyntheticAudio` rendering fake speech when mic was off; replaced with zero buffers + level=0. |
| Sidebar "Identify" / "Deepfake Lab" labels | `more-screens.jsx:14-18` | Real screens, not vapourware |

---

## Confidence breakdown

| Subsystem | Confidence | Why |
|---|---|---|
| Audio capture (browser) | HIGH | MediaRecorder + AnalyserNode, exercised in production every session |
| VAD + sample-quality gate | HIGH | Real DSP, unit-tested with real audio fixtures |
| `/enroll` route | HIGH | Real flow tested manually + via smoke; quality gate runs real algorithms |
| `/verify` route | MEDIUM | Real ML in production; **not exercised by automated tests** (F-5). Manual smoke confirms end-to-end ACCEPT/REJECT works on the same operator's voice. No accuracy data on OTHER speakers. |
| `/identify` route | MEDIUM | Same as `/verify`. Ranking logic correct in tests (against stubs); ranking ACCURACY against real speakers untested. |
| `/spoof` route | MEDIUM | System-TTS path produces real audio; XTTS path completely untested at this commit (deferred to v1.1). |
| `/spoof/test` route | MEDIUM | Real AASIST exercised in unit tests (only route that does); real-world detection effectiveness on macOS TTS is **documented as poor** (CHANGELOG.md known limitation). |
| `/metrics/summary` | HIGH | Real registry, real percentile, unit tests cover the shape + arithmetic |
| `/users` (list / delete) | HIGH | Trivial CRUD over SQLite, well tested |
| `/readyz` | HIGH | Real DB ping, real file-existence checks, surfaces fallback state |
| Threshold calibration | NONE | Defaults are guesses (F-4) |
| Published EER on real datasets | NONE | Scripts ready, never run (F-5 epilogue) |

---

## What's missing for v1.0 to be defensible at sale

If a buyer's CTO read this audit and asked "what would convince me?" — the gaps to close are:

1. **Run the bench scripts on real data.** `backend/scripts/bench_eer_voxceleb.py` + `bench_spoof_detection.py` are wired and waiting. Land actual EER + tDCF numbers in `docs/benchmarks.md`. Without this, the security claims are unmeasurable.
2. **Add one real-model integration test.** A single `pytest -m slow` case that loads the real weights, enrols, verifies, and checks the response shape. Defends against silent regressions.
3. **Surface model provenance in API responses.** `model: "aasist" | "heuristic"` field on every score-bearing response. The fallback today is silent at the API layer.
4. **Calibrate the thresholds.** After (1) lands, plot the EER curve and pick the operating point with eyes open. Document the choice.
5. **Re-label the two cosmetic-honest panels** (`EmbeddingConstellation`, `LiveFeatures` jitter/shimmer) so the `LIVE` badge isn't read as "data."
6. **Assert the bundle budget in CI.** Cheap, defends against future bloat.
7. **Operator-guide "what to do if /readyz says weights missing"** — today there's no playbook.

Five of these are low-day-rate work. (1) is gated by dataset acquisition (1–2 days for the operator). (4) follows (1).

---

## What's *good* about this codebase

This audit is harsh. To balance:

- The **strip pass** was real. There used to be far more theatre (cookie auth, Hebrew i18n half-measures, three demo modes that played canned animations through screens that never touched the backend, hardcoded GPU-latency / inference-rate / 14-day-uptime fakes). All gone.
- The **MediaRecorder rewrite** fixed a real product bug (the AudioWorklet path was failing on the operator's setup with no surfacing; nothing recorded). The new recorder is universally supported and surfaces failures.
- The **system-TTS spoof fallback** is honest engineering — it means the deepfake lab works today on a Py 3.14 venv where XTTS won't install, with a header that tells the operator which engine ran.
- The **`/metrics/summary` wiring** killed the most visible UI lie ("11 ms p50, 62/s, 14 d uptime" hardcoded forever).
- The **`/identify` feature** was added cleanly with real backend ranking + 9 new pytest cases (against stubs, but the route logic is tested).
- The **CHANGELOG.md known-limitations section** is unusually honest. It explicitly documents the AASIST-vs-`say` weakness, the planned attack tiles, the deferred XTTS, and the heuristic sub-classifier mode. That kind of self-disclosure is rare.
- The **production weight files load and run** — direct verification confirms 7.7 M ReDimNet params and 300 K AASIST params, both consistent with the published architectures.

---

## Verdict

**Buy with conditions:**
1. Insist on the F-5 integration test before any further feature work.
2. Insist on F-1 + F-2 model-provenance flag surfacing.
3. Treat the 0.79 % / 0.83 % numbers as paper baselines, not product claims, until S3 lands.
4. Get the operator-guide updated with a runbook for the heuristic-fallback case.

**Do not buy** if:
- The use-case is high-stakes authentication (banking, border control). The thresholds are uncalibrated and the test suite proves nothing about real-world accuracy.
- You need cross-browser sign-off today. Only Chrome desktop is validated; the others are pending.

**Genuinely safe to buy** if:
- The use-case is operator-driven adversarial-testing (the design intent — security-research kiosk, demo for stakeholders). The pipeline is real, the UI is mostly honest, and the documented limitations are documented.

---

## Update — v1.0.3 (2026-05-12)

`v1.0.3` (`Plan.md` V0–V6) closes the last "schematic" / "approx" surfaces flagged in F-6 + F-7:
- ✅ **F-6 (closes outright)** — `EmbeddingConstellation` no longer derives geometry from `hash(profile.id)`. It plots real ReDimNet 192-d → PCA(3) projections of every enrolled centroid + per-sample dispersion, fed by the new `GET /users/embeddings`. The live point is real audio embedded via `POST /embed` and projected through the same basis. Operator can disable the live stream from the panel footer (`biovoice.constellation.liveOn` localStorage).
- ✅ **F-7 (closes outright)** — `LiveFeatures` no longer relies on FFT-bin shortcuts. It uses the new `frontend/src/lib/dsp.ts`: time-domain autocorrelation pitch with parabolic peak refinement, Levinson-Durbin LPC formants (order 12), cycle-to-cycle jitter from a rolling period buffer, and VAD-gated SNR (no `+18 dB` offset). Header label dropped from "(live mic · approx jitter)" to "(live mic)".

The "(schematic)" / "(approx jitter)" labels are gone. F-3 / F-4 status unchanged — those wait on trained sub-classifier heads (Plan §S2) and field-room calibration data (Plan §G4) respectively.

## Update — v1.0.2 (2026-05-10)

`v1.0.2` (`Plan.md` B0–B6) closes the calibration gap with measured numbers:
- ✅ **F-4** (uncalibrated thresholds) — measured EER on LibriSpeech (8000 pairs) + LibriSpeech vs `say` spoofs (600 clips). Calibration analysis written up in `docs/thresholds.md`. Both defaults kept (with rationale) rather than retuned to LibriSpeech-specific values.

Real numbers landed:
- Speaker verification: **EER 0.90 %** on LibriSpeech test-clean (paper baseline 0.79 % on VoxCeleb1-O).
- Anti-spoofing: **EER 29.0 %** on LibriSpeech bonafide vs `say` spoofs — measured proof of the cross-distribution gap already documented at audit time.

Plots + per-utterance CSVs live at `docs/paper/results/`. Reproducible via `docs/benchmarks.md` "Reproducing on a fresh box".

## Update — v1.0.1 (2026-05-10)

`v1.0.1` (`Plan.md` HF1–HF8, see `CHANGELOG.md`) closes:
- ✅ **F-1** — `model_provenance` block on every score-bearing response + red `DegradedBanner` in the UI.
- ✅ **F-2** — same plumbing covers the encoder fallback path.
- ✅ **F-5** — slow-marked `test_real_models_integration.py` loads real ReDimNet + AASIST and runs end-to-end. CI `backend-integration` job invokes it.
- ✅ **F-6** — `EmbeddingConstellation` panel re-labelled `(schematic)`, dropped the LIVE chip.
- ✅ **F-7** — `LiveFeatures` panel re-labelled with the `(approx jitter)` qualifier.
- ✅ **F-8** — bundle budget tightened 350 KB → 100 KB; `deploy/smoke.sh` asserts verify p50 ≤ 800 ms.

Discloses (doesn't fully resolve):
- 🟡 **F-3** — `AnalysisDetails.mode` flag added + UI label `ACOUSTIC FEATURES (heuristic v1.0 · not from AASIST)`. Trained heads remain a v1.1 deliverable.
- 🟡 **F-4** — `docs/thresholds.md` documents the operating-point trade-offs + retune procedure. Real calibration awaits the dataset acquisition gated in Plan.md §S3.

The verdict above stands on the underlying engineering, but the "buy with conditions" list (HIGH findings F-1, F-2, F-5) is now satisfied for the v1.0.1 tag.
