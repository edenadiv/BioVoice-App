# Remaining work — what's still left after the scaffolding strip

The kiosk has been re-scoped to a single-purpose operator surface.
Auth, i18n/RTL, admin, settings, demo modes — all removed. The list
below is what's still genuinely outstanding.

## What's done

- ✅ ReDimNet + AASIST wired into `verification.py` and `/verify`.
- ✅ Public route surface: `/enroll`, `/verify`, `/users` (GET+DELETE), `/results`, `/spoof`, `/spoof/test`, `/health`, `/readyz`, `/metrics`.
- ✅ Real EnrollModal (3-sample mic capture → backend quality gate → `/enroll`).
- ✅ Real VerificationOverlay (mic capture → `/verify` → ACCEPT / REJECT / DEEPFAKE).
- ✅ Real DeepfakeLab (target picker → `/spoof` clone → `/spoof/test` verdict).
- ✅ Profile delete (UI confirm → `DELETE /users/{id}` → soft delete).
- ✅ Three-screen sidebar shell (Console / Deepfake Lab / Profiles).
- ✅ AcousticProbe heuristic mode.
- ✅ Sample-quality gate (SNR, clipping, speech ratio).
- ✅ Energy-based VAD with adaptive threshold.
- ✅ Vitest + Playwright + axe + Lighthouse CI green.
- ✅ Bundle: ~70 KB gzipped (down from 101 KB after the strip).
- ✅ Backend pytest: 73 / 73.

## Closed since this list was last touched

- ✅ **EmbeddingConstellation now renders real ReDimNet 192-d → PCA(3)** (v1.0.3, 2026-05-12). Real per-profile centroids + per-sample orbiting dots + live point streamed via `POST /embed`. Toggleable from the panel footer.
- ✅ **LiveFeatures now uses real DSP** (v1.0.3): autocorrelation pitch, Levinson-Durbin LPC formants, cycle-to-cycle jitter, VAD-gated SNR. The "(approx jitter)" / "(schematic)" labels are gone.
- ✅ **Single-image deploy + installable PWA** (v1.1.0, 2026-05-12). 1.66 GB Docker image (CPU-only torch) deployable to Fly / Render / Railway / VPS; `docs/deployment.md` rewritten. PWA install via "Add to Home Screen" on iOS + Android. Lighthouse PWA 0.88. (Desktop bundled installer follows in v1.2.0.)

## Still outstanding

### G1 — Manual cross-browser QA

`docs/qa.md` § "Cross-browser test matrix" lists the 10-step protocol
to walk on each of the five target browsers. Today only Chrome desktop
has been touched in dev. The other four browsers' sign-off boxes are
still empty.

Owner: project lead (manual drive).

### G2 — Sub-classifier trained heads

`AcousticProbe` ships in heuristic mode (HNR / F0 / spectral
flatness). The trained-head path that the codebase used to load via
`SUB_CLASSIFIER_HEADS_PATH` was deleted with the admin route surface
that exposed the toggle. If we want the trained probe back:

1. Restore the `SubClassifier` checkpoint loader in
   `backend/app/services/sub_classifier.py`.
2. Train heads on a held-out validation set (script not yet written).
3. Set `SUB_CLASSIFIER_HEADS_PATH` in `.env` and load on boot.

Outcome: AASIST's binary score gets explained by four sub-axes
(naturalness / spectral / temporal / artifact) with calibrated
weights instead of the heuristic proxies.

### G3 — Real-dataset benchmarks ✅ (v1.0.2)

Real measured numbers landed at v1.0.2 (2026-05-10). Path was switched from gated VoxCeleb1 + ASVspoof to public LibriSpeech test-clean + self-built `say`-spoof set.

| Run | EER | Comparison |
|---|---|---|
| Speaker verification (LibriSpeech, 8000 pairs) | **0.90 %** | paper baseline 0.79 % on VoxCeleb1-O |
| Anti-spoofing (LibriSpeech bonafide vs `say` spoofs, 600 clips) | **29.0 %** | confirms the AASIST-vs-`say` gap documented in operator-guide |

DET / ROC plots + per-utterance CSVs: `docs/paper/results/`. Reproduce per `docs/benchmarks.md`. Threshold calibration analysis in `docs/thresholds.md`.

Future work (deferred):
- Run on the gated VoxCeleb1 + ASVspoof for direct paper-baseline comparison (operator's call on the registration friction).
- Run on XTTS-v2 cloning attacks (gated by Plan §S2).

### G4 — Multi-speaker enrolment study

`docs/qa.md` § "Final acceptance with real speakers" — 10-volunteer
study with day-separated enrol + verify + cross-spoof. Volunteer
recruitment is the gating step.

### G5 — Postgres migration

`docs/postgres_migration.md` — SQLite is fine for the kiosk; if we
ever multi-instance the deployment we need the Postgres shim. Code
not yet written.

### G6 — Threshold-tuning surface

The auth-gated admin page used to expose `similarity_threshold` +
`deepfake_threshold` sliders. After the strip, an operator who wants
to retune those values has to edit `backend/app/core/config.py` and
restart uvicorn. If the volunteer study (G4) shows we need
field-tunable thresholds, re-introduce a public route or a small
operator-only CLI.

### G7 — Operator restore tool

`soft_delete_speaker` moves rows from `users` → `deleted_users`. There
is no "undelete" path today. If an operator clicks delete by mistake
the only recovery is to re-enrol from scratch.

### G8 — Operator authentication (only if deployment changes)

The kiosk is currently designed for a controlled physical
environment — no auth is intended. If the deployment model changes
(e.g. accessible from a shared network), revisit the auth strip
decision logged in `Plan.md`.
