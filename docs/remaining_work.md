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

### G3 — Real-dataset benchmarks

No benchmark yet against ASVspoof 2019 LA / 2021 DF / WaveFake. To
publish accuracy claims we need:

1. Pull the dataset (eval split + protocols).
2. Run `app.services.verification.verify` over each utterance.
3. Compute EER + tDCF; report alongside the published baselines.

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
