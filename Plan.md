# BioVoice — Ship It Plan

> **Status**: drafted 2026-05-10 · single-kiosk (Mac/Linux) field deployment · real XTTS · published benchmarks
> **Supersedes**: the pre-strip Wire-Live Migration Plan (kept in git history). Auth, i18n, admin, demo modes were all stripped on `feat/strip-scaffolding`; that work is the new floor this plan builds on.

---

## Context

After the strip + recorder rewrite + fallback spoof work, the kiosk *runs end-to-end on real ML* (ReDimNet + AASIST), the recorder works (MediaRecorder + AnalyserNode, no worklet), and the deepfake lab produces real synthetic audio via the macOS `say` fallback. Backend pytest 76/76, Vitest 14/14, Playwright 7/7, bundle 72 KB gzipped. `/readyz` green with both weight files loaded.

But it's not *shipped* yet. The audit found:

- **Cosmetic fakes still on screen** — Console panel hardcodes `GPU latency 11ms / Inference 62/s / Uptime 14d` (`frontend/src/console.jsx:425-428`); the DeepfakeLab "ATTACK MODEL" picker offers `clone-v3 / replay / splice` but only `clone-v3` is wired to the backend (`frontend/src/more-screens.jsx:78,210`). Both lie about real state.
- **No published benchmark numbers**. AASIST + ReDimNet run, but we've never validated EER/tDCF against ASVspoof or VoxCeleb. Without numbers, the "0.79% EER" displayed in the model panel is invented.
- **System-TTS spoof works but AASIST doesn't catch macOS `say` voices**. Real voice cloning needs XTTS-v2, which doesn't install on the Py 3.14 dev venv. Production Docker image is Py 3.12 — XTTS *can* land there.
- **Stale docs**. `docs/deployment.md` still references `BIOVOICE_ADMIN_API_KEY`, session/cookie env vars, and other surfaces that were deleted in the strip.
- **No hardware runbook** — no spec for the Mac mini / NUC the kiosk is supposed to run on, no measured cold-start timing.
- **G1 (cross-browser QA) and G4 (volunteer study) still open**. G4 is multi-week; out of scope for ship.

Decisions locked from the user:

| Topic | Choice |
|---|---|
| Deploy target | Single kiosk on Mac/Linux box, operator-driven |
| XTTS | Migrate to Py 3.12 + install real XTTS-v2 for real cloning |
| Eval rigour | Published benchmarks: ASVspoof 2019 LA (AASIST), VoxCeleb1-O (ReDimNet) |
| Cosmetic fakes | Replace with real `/metrics` values; keep attack-picker tiles but mark replay/splice as `PLANNED` |

Outcome: a single-command deploy on a clean Mac/Linux box where every on-screen number traces to the live backend, real voice cloning works, and we can cite real EER numbers when asked.

---

## Phase S1 — UI truth (kill the cosmetic fakes)

**Goal**: every number on screen comes from the backend or is honestly labelled.

### S1.1 Real console metrics
- **Backend**: `app/api/routes.py` add `GET /metrics/summary` returning JSON:
  ```json
  { "p50_verify_ms": 412, "throughput_per_sec": 1.7, "uptime_sec": 88200, "cold_start_at": "..." }
  ```
  Read from the existing `app/core/metrics.py` Prometheus registry — derive p50 from the `biovoice_verify_seconds` histogram, throughput from `biovoice_verifications_total / uptime`, uptime from a process-start timestamp captured at module import.
- **Frontend**: `frontend/src/lib/api.ts` — add `getMetricsSummary()` helper. New `frontend/src/lib/useMetricsSummary.ts` polls every 5 s with the same `useResultsPolling` pattern.
- **Frontend wiring** — `frontend/src/console.jsx:421-430` Metric components: drop the hardcoded `"11ms" / "62/s" / "14 d"`. Read from `useMetricsSummary()`. Empty state: render `"—"` until first poll lands.

### S1.2 DeepfakeLab attack-model picker
- `frontend/src/more-screens.jsx:209-225` — keep all three tiles for visual completeness, but:
  - `clone-v3` stays clickable.
  - `replay` and `splice` get a `disabled` prop + `<span style={{...}}>PLANNED</span>` badge in the lower-right corner.
  - Clicking a planned tile shows a tooltip / inline message ("Coming in v1.1 — currently routes to voice clone.") and doesn't change `model` state.
- Result panel (`frontend/src/more-screens.jsx` ~line 280, `result.model`) — drop the prop since only one path is real.

### S1.3 Settings panel mock model status
- `frontend/src/console.jsx` SettingsPanel — find `MIC PERMISSION granted`, the `READY/STANDBY` model pills, and the static model list (`ReDimNet-B5 / AASIST / TCAV STAGE-4 / F5-TTS`). Replace with:
  - `MIC PERMISSION` from `navigator.permissions.query({name: 'microphone'})` (real browser state).
  - Model readiness from a new `getReady()` helper that hits `/readyz` and reflects `aasist_weights.ok` + `redimnet_weights.ok`.
  - Drop `TCAV STAGE-4` and `F5-TTS` — neither exists in the codebase. Show only `ReDimNet-B5` + `AASIST` + `XTTS-v2 (or fallback)` based on what's actually loaded.

### S1.4 Tests + verification
- Vitest: new `useMetricsSummary.test.ts` (~3 cases: poll fires, parses, swallows network errors).
- Backend pytest: `test_metrics_summary.py` (3 cases: empty state, populated state, format).
- Playwright `enroll.spec.ts` — assert the Metric components render values from the backend, not hardcoded literals.

**Files**:
- `backend/app/api/routes.py` — add `/metrics/summary`
- `backend/app/core/metrics.py` — add `summary()` extractor
- `backend/tests/test_metrics_summary.py` — new
- `frontend/src/lib/api.ts` — add `getMetricsSummary()`
- `frontend/src/lib/useMetricsSummary.ts` — new
- `frontend/src/console.jsx` — Metric + SettingsPanel rewires
- `frontend/src/more-screens.jsx` — DeepfakeLab picker + result panel
- `frontend/src/lib/useMetricsSummary.test.ts` — new

## Phase S2 — Real XTTS voice cloning (Py 3.12 backend)

**Goal**: `/spoof` produces real voice-cloned audio, not a generic `say` voice. AASIST catches it as FAKE.

### S2.1 Switch the dev venv to Py 3.12
- `backend/.python-version` — pin to 3.12.
- Re-create venv: `pyenv install 3.12.10 && pyenv local 3.12.10 && python -m venv .venv && .venv/bin/pip install -e ".[model,spoof,test]"`.
- Verify: `.venv/bin/python -c "import TTS; print(TTS.__version__)"` → `0.22.x`.
- Update `docs/operator-guide.md` quick-start to specify Py 3.12 (currently silent on the version).

### S2.2 XTTS-v2 checkpoint
- Download `XTTS-v2/config.json` + `XTTS-v2/model.pth` (and `vocab.json`, `speakers_xtts.pth` if used) from Coqui's HuggingFace mirror. ~1.8 GB.
- Place at `<repo>/XTTS-v2/` (matches `Settings.xtts_model_path` default at `backend/app/core/config.py:50`).
- Add the path to `.gitignore` (don't commit 1.8 GB).
- Add a `scripts/download_xtts.sh` helper (curl + sha256 verify).

### S2.3 End-to-end XTTS smoke
- `_xtts_available()` (already in `backend/app/services/spoof.py`) returns true once both the package and the checkpoint dir are present.
- Smoke: enrol `e2e_xtts` with 3 real samples (use `say` to produce input, or operator records manually), then POST `/spoof` with `target_user_id=e2e_xtts` + arbitrary text. Response WAV should sound like the operator's voice, not Siri.
- Run the resulting WAV through `/spoof/test` — AASIST should score it < 0.5 → DEEPFAKE. **This is the criterion for "XTTS works"**.
- If AASIST still misses the XTTS clone, log it as a separate finding (see Phase S3 — benchmarks should expose this anyway).

### S2.4 Production Docker image
- Backend Dockerfile already targets Py 3.12 (`Dockerfile:25 FROM python:3.12-slim AS build`).
- Add the XTTS checkpoint mount to `docker-compose.yml` (read-only volume from host `XTTS-v2/` → container `/app/XTTS-v2`).
- Verify the image still builds + boots: `docker compose build && docker compose up -d && curl https://localhost/readyz`.

### S2.5 Tests
- `backend/tests/test_xtts_spoof.py` (skip if `_xtts_available()` is false in CI) — 2 cases: real cloning produces WAV (>10 s of audio), the WAV decodes via wave.open without error.
- Don't bench AASIST-on-XTTS in unit tests (slow, model-dependent) — that's S3's job.

**Files**:
- `backend/.python-version` — new
- `scripts/download_xtts.sh` — new
- `.gitignore` — add `XTTS-v2/`
- `docker-compose.yml` — add XTTS volume mount
- `docs/operator-guide.md` — Py 3.12 + XTTS-install steps
- `docs/deployment.md` — same
- `backend/tests/test_xtts_spoof.py` — new

## Phase S3 — Published benchmarks (real numbers)

**Goal**: docs/benchmarks.md states our actual EER on ASVspoof 2019 LA + VoxCeleb1-O test pairs, comparable to the published baselines.

### S3.1 ASVspoof 2019 LA evaluation (AASIST)
- Download protocol files + eval split (`ASVspoof2019.LA.cm.eval.trl.txt`, eval audio under `ASVspoof2019_LA_eval/flac/`).
- New `backend/scripts/eval_aasist.py` (Python 3.12, scipy + torchaudio):
  1. Iterate every utterance in the eval protocol.
  2. Decode FLAC → 16 kHz mono float32.
  3. Run through `DeepfakeDetectorService.detect()`.
  4. Emit per-utterance `(filename, score, label)` to a CSV.
  5. Compute EER + min-tDCF using the ASVspoof tDCF helper (vendor `evaluate_tDCF_asvspoof19.py` or pip `asvspoof-baseline-utils`).
- Expected: EER somewhere in the 1–10% range depending on subset coverage. Document whatever we get.

### S3.2 VoxCeleb1-O evaluation (ReDimNet)
- Download VoxCeleb1 test pairs file (`veri_test2.txt`) + the test audio.
- New `backend/scripts/eval_redimnet.py`:
  1. For each pair: load enrol + test WAVs, run through `RedimNetSpeakerEncoder.embed()`.
  2. Compute cosine similarity (the encoder's built-in `cosine_similarity`).
  3. Emit `(score, label)` to CSV.
  4. Compute EER (sklearn `roc_curve` → find threshold where FAR == FRR).
- Compare to the ReDimNet paper's published 0.79% EER on VoxCeleb1-O. Expect close, not identical (vendored model may be a different snapshot).

### S3.3 Threshold cross-validation
- Plot the EER curve from each script.
- If our default `similarity_threshold=0.75` or `deepfake_threshold=0.5` are clearly off the EER point, retune in `backend/app/core/config.py` and re-run the smoke test.
- Document the chosen threshold + rationale in benchmarks.md.

### S3.4 Document
- New `docs/benchmarks.md`:
  - Table: model, dataset, EER, min-tDCF, our number vs published baseline.
  - How to reproduce (commands, expected runtime, hardware used).
  - Threshold-vs-EER plots (savefig from the eval scripts).
- Update `docs/remaining_work.md` G3 → ✅ done (move to "what's done").

**Files**:
- `backend/scripts/eval_aasist.py` — new
- `backend/scripts/eval_redimnet.py` — new
- `docs/benchmarks.md` — new
- `docs/remaining_work.md` — mark G3 done

## Phase S4 — Stale-doc pass + hardware runbook

**Goal**: every doc in `docs/` reflects post-strip reality. Operators have a hardware spec to procure against.

### S4.1 docs/deployment.md
- Strip references to `BIOVOICE_ADMIN_API_KEY`, `SESSION_IDLE_SECONDS`, `LOGIN_RATE_*`, `BIOVOICE_COOKIE_INSECURE` (all deleted in the strip).
- Add: Py 3.12 + XTTS install instructions (link to S2.2's `download_xtts.sh`).
- Update the env-var table: only the surfaces that exist now (CORS_ORIGINS, LOG_LEVEL, BIOVOICE_LOG_FORMAT, DATABASE_URL).
- Add: production cert provisioning (Let's Encrypt via certbot for the kiosk hostname, or self-signed for closed-network deploys).

### S4.2 docs/qa.md
- Already slimmed in the strip pass. Spot-check for any remaining auth/i18n references.

### S4.3 docs/hardware.md (new)
- Target device options: Mac mini M2 (16 GB RAM, 256 GB SSD) **or** Intel NUC (i5+, 16 GB, 256 GB) running Ubuntu 22.04 LTS.
- Mic spec: USB condenser mic with cardioid pattern (e.g., Blue Yeti, ~$130) — better SNR than built-in laptop mics; the quality gate is strict on SNR ≥ 10 dB.
- Touchscreen optional; standard HDMI display + mouse + keyboard works.
- Power: UPS recommended (5-min runtime min) so cold-start doesn't burn through enrolment data.
- Network: optional. Kiosk runs offline once weights + frontend bundle are baked into the Docker image.

### S4.4 Cold-start timing
- Boot the production Docker stack on the target hardware.
- Time from `docker compose up -d` → `/readyz` returns ready.
- Time from process start → first `/verify` call (model load happens lazily on first call — either keep that or move to eager load).
- Document in hardware.md as a baseline. If cold-start > 30 s on first verify, add a `warmup` script that's invoked at container start.

**Files**:
- `docs/deployment.md` — rewrite env section + Py 3.12 + XTTS install
- `docs/hardware.md` — new
- `docs/operator-guide.md` — link to hardware.md from the boot section

## Phase S5 — Deploy verification (clean-machine smoke)

**Goal**: a fresh `git clone` on a target box → working kiosk in < 30 minutes, following only the docs.

### S5.1 Walk the deploy from scratch
- Pick a clean test box (could be the same Mac via a fresh VM or a wiped data dir).
- Follow `docs/deployment.md` TL;DR step-by-step. **Don't deviate.** Note every hiccup.
- Fix any doc gap that surfaces. Re-walk.

### S5.2 Cross-browser QA (G1)
- Run the 10-step protocol from `docs/qa.md` on:
  - Chrome desktop (already validated — re-confirm)
  - Safari desktop
  - Firefox desktop
  - Mobile Safari (iPhone simulator + a real device if possible)
  - Mobile Chrome (Android simulator)
- Mark sign-off boxes in qa.md as you go.

### S5.3 Backup / restore round-trip
- Run `deploy/backup.sh` after enrolling 5 users.
- Wipe `data/` directory.
- Run `deploy/restore.sh` from the backup tarball.
- Verify all 5 profiles list correctly + verify still works against them.

### S5.4 Telemetry sanity
- Confirm `/api/metrics` Prometheus output looks sane after 100 verifies.
- Confirm `/api/metrics/summary` (S1) reflects the same.
- (No external monitoring stack assumed — local file-based logs are enough for single-kiosk.)

## Phase S6 — Release v1.0.0

**Goal**: a tagged release, a clean README, an operator handoff doc.

### S6.1 README.md rewrite
- Replace whatever's there now with:
  - One-paragraph elevator pitch (voice-biometric kiosk for adversarial testing).
  - Quick-start: `docker compose up -d` + link to operator-guide.
  - Feature checklist (what's wired, what's planned).
  - Link to benchmarks.md, hardware.md, operator-guide.md.

### S6.2 CHANGELOG.md (new)
- v1.0.0 release notes — what's in the box, what's known to be limited (AASIST-vs-`say` if no XTTS, the planned attack tiles).

### S6.3 Tag + GitHub release
- `git tag v1.0.0 && git push --tags`.
- Draft a GitHub release with the changelog excerpt + links to the docs.
- (No binary artefacts — single-kiosk doesn't need them.)

---

## Critical files (paths to touch)

### Backend
- `backend/.python-version` — new
- `backend/app/api/routes.py` — `/metrics/summary` route
- `backend/app/core/metrics.py` — `summary()` extractor
- `backend/app/services/spoof.py` — verified XTTS path is healthy (no code changes if `_xtts_available` already covers it)
- `backend/scripts/eval_aasist.py` — new
- `backend/scripts/eval_redimnet.py` — new
- `backend/tests/test_metrics_summary.py` — new
- `backend/tests/test_xtts_spoof.py` — new (skipped if XTTS missing)

### Frontend
- `frontend/src/console.jsx` — Metric panel + SettingsPanel rewires (kill `11ms / 62/s / 14d`)
- `frontend/src/more-screens.jsx` — DeepfakeLab picker (PLANNED badge on replay/splice)
- `frontend/src/lib/api.ts` — `getMetricsSummary` + `getReady`
- `frontend/src/lib/useMetricsSummary.ts` — new (polling hook)
- `frontend/src/lib/useMetricsSummary.test.ts` — new

### Docs
- `Plan.md` — this file (S0)
- `README.md` — rewrite (S6.1)
- `CHANGELOG.md` — new (S6.2)
- `docs/deployment.md` — strip dead env vars + Py 3.12 + XTTS install
- `docs/operator-guide.md` — Py 3.12 callout + hardware link
- `docs/hardware.md` — new
- `docs/benchmarks.md` — new
- `docs/remaining_work.md` — mark G1, G3 done; defer G2/G4 to v1.1

### Ops
- `scripts/download_xtts.sh` — new
- `docker-compose.yml` — XTTS volume mount
- `.gitignore` — XTTS-v2/ + benchmark artefacts

## Verification (run end-to-end before tagging v1.0.0)

1. **Unit + integration**: `cd backend && .venv/bin/pytest -q` → ≥ 78 pass (76 today + S1 metrics test + S2 XTTS test).
2. **Frontend unit**: `cd frontend && npm test` → ≥ 17 pass (14 today + 3 useMetricsSummary tests).
3. **Frontend bundle**: `cd frontend && npm run build` → bundle ≤ 80 KB gzipped (some headroom for new metric helpers).
4. **E2E**: `cd frontend && npx playwright test --project=chromium-desktop` → ≥ 8 pass (7 today + an updated enroll.spec asserting real metric values).
5. **XTTS smoke**: enrol a profile, `/spoof` returns a WAV that's audibly the same speaker, `/spoof/test` flags it ≥ 50 % of the time as DEEPFAKE.
6. **Bench**: `python backend/scripts/eval_aasist.py --eval ASVspoof2019.LA.cm.eval.trl.txt` produces a CSV + EER number; same for ReDimNet. Numbers landed in `docs/benchmarks.md`.
7. **Cold deploy**: fresh `git clone` on a wiped box, follow `docs/deployment.md`, kiosk live in < 30 min.
8. **Cross-browser**: 10-step QA passes on Chrome/Safari/Firefox/iOS/Android.
9. **Backup round-trip**: enrol → backup → wipe → restore → verifications still match.
10. **Tag**: `git tag v1.0.0 && git push --tags`.

## Effort summary

| Phase | Engineer-days |
|---|---|
| S1 — UI truth (kill cosmetic fakes) | 1.0 |
| S2 — Real XTTS (Py 3.12 + checkpoint + smoke) | 1.5 (most of it is download + venv switch) |
| S3 — Published benchmarks (ASVspoof + VoxCeleb) | 2.0 |
| S4 — Stale docs + hardware runbook | 0.5 |
| S5 — Cross-browser QA + cold deploy | 1.0 |
| S6 — Release v1.0.0 | 0.4 |
| **Total** | **~6.5 engineer-days** |

Stack as 4 sequential PRs off `feat/strip-scaffolding`:
- PR-A: S1 (UI truth)
- PR-B: S2 + S4 (XTTS + docs)
- PR-C: S3 (benchmarks — separate because it touches dataset paths and is heavy)
- PR-D: S5 + S6 (deploy verification + release tag)

Out of scope (deferred to v1.1):
- G2 trained sub-classifier heads (research-grade work).
- G4 10-speaker volunteer study (multi-week recruitment).
- G5 Postgres migration (single-kiosk doesn't need HA).
- G7 soft-delete restore tool (manual SQL recovery is enough at v1.0).
- G6 threshold-tuning UI (operator can edit config + restart for now; revisit if S3 shows the defaults need frequent retuning).
</content>
</invoke>