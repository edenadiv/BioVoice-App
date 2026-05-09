# Remaining work — what's still mockup or missing

This is the truth-table of every claim in the system that isn't yet
empirically backed or runtime-verified. Each gap is a **G-task** with
sub-functions, owner role (engineer / contractor / operator / project
lead), file paths, effort estimate, and a single verification
criterion that closes the gap.

Effort uses **engineer-days** (1 day = ~6 productive hours). "Blocker"
items list the external resource needed; engineering effort is gated
by that resource arriving.

---

## G1 — Wire the real ML core (unblocks every accuracy claim)

**Why**: in the current dev venv, `app/services/speaker_encoder.py` and
`app/services/detector.py` both fall back to placeholder paths because
they can't import `biovoice.core.vendor.aasist.aasist_model`. Result:
the kiosk's ReDimNet returns hash-based embeddings (cannot tell two
speakers apart) and AASIST returns an amplitude heuristic (cannot detect
deepfakes). The decision pipeline runs end-to-end but produces noise.

**Owner**: engineer · **Effort**: 0.5 day · **Blocker**: none

### G1.1 — Install the model extras in the active venv
- `cd backend && .venv/bin/pip install -e ".[model]" --no-build-isolation`
- Verify `python -c "import torch, numpy, scipy"` exits 0.
- Verify `python -c "from biovoice.core.vendor.aasist.aasist_model import AASISTModel"` succeeds (the `biovoice` namespace is provided by the `[model]` extra; if the import still fails, the vendor module path needs to be added to `pyproject.toml`).

### G1.2 — Confirm AASIST + ReDimNet weights load
- Boot uvicorn with `LOG_LEVEL=DEBUG`.
- POST one verification.
- Assert the log shows `"Loading AASIST weights from …/aasist.pt"` and `"Loading ReDimNet weights from …/redimnet_b5.pt"` (no fallback warnings).

### G1.3 — Functional sanity: same speaker → ACCEPT, different speaker → REJECT
- Capture two real-microphone WAVs from yourself + one other person.
- Enrol speaker A with 3 of your samples.
- Verify A→A: expect ACCEPT, similarity ≥ 0.75.
- Verify A→B: expect REJECT, similarity < 0.75.
- If the pair fails (both ACCEPT or both REJECT), G1.1 / G1.2 didn't actually wire the real models — re-debug.

### G1.4 — Pin the model dependency in CI
- `.github/workflows/ci.yml` already runs `pip install -e ".[model]"`. Confirm the latest CI run on `main` is green for the backend job; if not, surface the install log and either pin transitive deps or add a missing apt package.

**Verification**: G1.3 passes with both decisions correct on real recordings.

---

## G2 — Manual browser QA pass (12-step protocol from `docs/qa.md`)

**Why**: every frontend feature added in F2.5 / F3.1 / F5 / F6 is wired
and builds, but never opened in a browser this session. Bugs in
event flow, cookie handshake, AudioWorklet capture, RTL layout are
guaranteed to be present.

**Owner**: engineer · **Effort**: 0.5 day · **Blocker**: G1 (so the
verify step produces real decisions)

### G2.1 — Boot stack + open kiosk
- `cd backend && .venv/bin/uvicorn app.main:app` with
  `BIOVOICE_COOKIE_INSECURE=1` for HTTP local dev.
- `cd frontend && npm run dev`.
- Open `http://127.0.0.1:5173` in Chrome.

### G2.2 — Capture screenshots for the documentation
- Save under `docs/screenshots/` per screen (welcome / console / enroll / verify / deepfake-lab / profiles / settings / admin) at 1920×1080.
- Save mobile equivalents at 414×896 and 768×1024 from Chrome DevTools' device emulator.

### G2.3 — Walk the 12-step protocol from `docs/qa.md` §F9.1
- Mark each step pass/fail in `docs/qa-results-<date>.md`.
- For every fail: capture the console log, the network request that broke, and the screenshot → file as a separate engineering issue.

### G2.4 — Verify cookie auth in the real browser
- Network tab: confirm the `Set-Cookie: biovoice_session=…; HttpOnly; SameSite=Strict` lands on /auth/login.
- Application → Cookies: confirm the cookie is HttpOnly + present after page reload.
- Refresh: confirm `getSession()` succeeds without re-login.
- Logout: confirm the cookie is cleared and a subsequent `getSession()` returns 401.

### G2.5 — Verify the AudioWorklet recorder
- Open DevTools console; record a verification.
- Assert no `ScriptProcessorNode is deprecated` warning fires (confirms the worklet path was selected).
- Assert the resulting WAV is 16 kHz mono on the network panel.

### G2.6 — Verify the language switcher + RTL flip
- Click `עב` in the sidebar.
- Assert `<html lang="he" dir="rtl">` in the Elements panel.
- Assert sidebar nav labels translate (Console → מסוף, etc.).
- Assert the Welcome screen copy translates (the only screen with full extraction so far).
- Assert the layout mirrors (sidebar moves to the right edge).

### G2.7 — Verify the admin screen
- Click the 5th sidebar item.
- Paste `BIOVOICE_ADMIN_API_KEY` (the value used to start the backend).
- Assert the threshold sliders populate with the current backend values.
- Move similarity slider to 0.82, click Save.
- Assert `threshold.update` event appears in the audit log feed.
- Click Refresh on the audit log; confirm the new event lands.

**Verification**: every step in G2.3 + G2.4 + G2.5 + G2.6 + G2.7 marked pass.

---

## G3 — Finish the per-screen i18n extraction

**Why**: F5.2 only extracted the sidebar nav + WelcomeScreen literals.
Every other screen (`screens.jsx`, `console.jsx`, `console-ext.jsx`,
`more-screens.jsx`, plus the new `admin-screen.jsx`) still has
hardcoded English JSX strings. Hebrew toggle currently flips ~10 % of
visible copy.

**Owner**: engineer (mechanical) · **Effort**: 1.5 days · **Blocker**: none

### G3.1 — EnrollScreen
- File: `frontend/src/screens.jsx` (search `function EnrollScreen`)
- Extract: prompt copy, sample-progress label ("X of N samples captured"), retry CTA, error messages.
- Add keys under `enroll.*` in `frontend/src/i18n/{en,he}.json` (the schema is already drafted in those files for `enroll.title`, `enroll.userIdLabel`, `enroll.samplesProgress`, `enroll.tapToRecord`, `enroll.qualityScore`, `enroll.rejected` — wire them up).

### G3.2 — VerifyScreen
- File: `frontend/src/screens.jsx` (search `function VerifyScreen`)
- Extract: status copy, decision banners (ACCEPT / REJECT / DEEPFAKE), per-axis labels.
- Add keys under `verify.*`.

### G3.3 — DeepfakeScreen
- File: `frontend/src/screens.jsx` (`function DeepfakeScreen`)
- Extract: intro copy, "ETHICAL USE ONLY" banner, the four sub-axis labels.
- Add keys under `deepfake.*`.

### G3.4 — ProcessingScreen
- File: `frontend/src/screens.jsx`
- Extract: per-stage labels (Embed / Match / Detect).
- Add keys under `processing.*`.

### G3.5 — ConsoleScreen
- File: `frontend/src/console.jsx` (~600 lines)
- Extract: counter labels (already in `console.*` skeleton — wire them), activity-feed action descriptors, last-event subtitles.

### G3.6 — VerificationOverlay
- File: `frontend/src/console-ext.jsx`
- Extract: phase labels ("Speak now", "Embedding", "Matching", "Detecting"), error messages, retry CTAs.

### G3.7 — DeepfakeLab
- File: `frontend/src/more-screens.jsx`
- Extract: ~50 strings (target-voice picker labels, script placeholder, model dropdown options, pipeline-stage descriptors, result-panel headings).

### G3.8 — ProfilesPage / UserSettingsPage
- File: `frontend/src/more-screens.jsx`
- Extract: empty-state copy, settings labels.

### G3.9 — AdminScreen
- File: `frontend/src/admin-screen.jsx`
- Extract: section headers, slider labels, button text, empty-state copy.

**Verification**: `grep -rEn '>[A-Z][a-z]+ [a-z]+' frontend/src/*.jsx` returns no untranslated user-visible strings (with documented exceptions: code identifiers, brand names, debug labels).

---

## G4 — Native-Hebrew-speaker translation review

**Why**: the Hebrew strings in `frontend/src/i18n/he.json` are my own
work. Functional, but no native speaker has reviewed them. Two specific
risks: (1) calque from English word order, (2) wrong register for an
Israeli government deployment context.

**Owner**: localisation contractor or in-team native speaker · **Effort**: 0.5 day for the contractor · **Blocker**: contractor engagement

### G4.1 — Engage a reviewer
- Project lead picks: external localisation contractor (e.g. Lionbridge / Smartling) OR an in-team native speaker. Budget: ~4 hours.

### G4.2 — Hand over the brief
- Source: `frontend/src/i18n/en.json`
- Target: `frontend/src/i18n/he.json`
- Context: kiosk for Israel National Cyber Directorate; formal register; technical security audience.

### G4.3 — Reviewer edits and returns
- Direct edit on `he.json` (it's a flat JSON file).
- Open a PR labelled `i18n: hebrew review`.

### G4.4 — Engineer merges
- Visual smoke check of every screen with the reviewed copy.
- No code change required.

**Verification**: PR merged + reviewer signs off in the PR description.

---

## G5 — Trained F4 probe heads (replace heuristic mode in production)

**Why**: `AcousticProbe` runs in heuristic mode because
`backend/models/aasist_heads.pt` doesn't exist. Heuristic mode is real
audio-derived (not seeded jitter), but it's calibration constants on a
small TIMIT-style sample, not a learned model. The training pipeline
+ methodology doc are written; the run hasn't happened.

**Owner**: ML engineer · **Effort**: 5 days (mostly dataset prep) · **Blocker**: labelled corpus

### G5.1 — Acquire raw datasets (~6 GB total)
- VoxCeleb1: ≥ 2,000 clips of bonafide speech. Public download with registration.
- ASVspoof2019 LA train+dev: ≥ 2,000 clips of synthesised / replay attacks. Public.
- F5-TTS / XTTS / ElevenLabs clones of 10 VoxCeleb1 identities × ~100 utterances each. Generate via `backend/scripts/generate_clones.py` (to be authored — see G5.2).

### G5.2 — Author `scripts/generate_clones.py`
- New file: `backend/scripts/generate_clones.py`.
- Takes a VoxCeleb1 reference + a transcript list + a TTS family selector.
- Calls XTTS-v2 (already wired in `app/services/spoof.py`) for the in-house clones; documents the manual ElevenLabs export workflow for the third-party ones.

### G5.3 — Annotate the four axes
- Two paths:
  - **Hand-annotated** (preferred): three expert reviewers per clip, target Krippendorff's α > 0.7. Tooling: a simple webapp the operator runs locally; out of scope for this task — operators may use Label Studio or equivalent.
  - **Proxy-labelled** (bootstrap): author `backend/scripts/build_proxy_labels.py` — takes an audio file, computes the F4 acoustic features, derives the four axes via the heuristic-mode formulas, writes a CSV row. Used to train v0 heads while hand-annotation runs in parallel.

### G5.4 — Train heads
- `cd backend && .venv/bin/python scripts/train_sub_classifier.py --manifest /data/sub_classifier/train.csv --output models/aasist_heads.pt --epochs 50 --report-thresholds`
- Verify the training script's per-epoch loss curve drops monotonically.

### G5.5 — Validate
- Held-out test split (15 % of the corpus). Per-axis Pearson r > 0.6 vs. annotated labels.
- If r < 0.6 on any axis, the heuristic features may not discriminate that axis — document in `docs/paper/sub_classifier.md` §6 and either accept the heuristic as the production answer for that axis or extend the feature set.

### G5.6 — Update production thresholds
- The training script's `--report-thresholds` flag prints per-axis EER thresholds.
- Bake them into `backend/app/core/config.py` as the new defaults for `voice_naturalness_threshold` etc.

**Verification**: `pytest tests/test_acoustic_probe.py::test_correlations` (to be authored) passes with r > 0.6 per axis.

---

## G6 — PostgresStore implementation (unblocks multi-instance HA)

**Why**: SQLite is fine for single-instance kiosks under ~10k enrolled
users. Beyond that, or for multi-instance HA, Postgres is required.
The migration plan + data-copy script + connection abstraction are
documented; the actual store class isn't written.

**Owner**: backend engineer · **Effort**: 3 days · **Blocker**: none

### G6.1 — Author `app/storage/postgres_store.py`
- Implement every method on the existing `VerificationStore` /
  `SessionStore` / `LoginRateLimitStore` / `AuditStore` Protocols.
- Use `asyncpg` directly (lighter than SQLAlchemy) OR `SQLAlchemy 2.x` async (gives you migrations). Pick one and document in the file header.
- Pool size: 5–10 connections per worker.
- Set `statement_timeout = '5s'` at connection level.

### G6.2 — Alembic migrations
- `cd backend && alembic init migrations`.
- Author `0001_initial_schema.py` mirroring `app/storage/sqlite_store.py:_ensure_schema` exactly. Postgres-specific deltas:
  - `audit_log.event_id` → `BIGSERIAL`
  - `users.embedding_json` / `sample_embeddings_json` → `JSONB`
  - `verification_seq` → real `CREATE SEQUENCE` per day
- Run `alembic upgrade head` against a local Postgres.

### G6.3 — Container wiring
- `app/core/container.py`: pick store based on `settings.database_url` scheme (`postgres://…` → `PostgresStore`, else SQLite).

### G6.4 — Tests
- Run the existing pytest suite against Postgres: `DATABASE_URL=postgres://… pytest backend/tests/`.
- Add a `tests/test_postgres_store.py` that round-trips every method (mirror existing `test_sqlite_store.py` style).

### G6.5 — CI
- `.github/workflows/ci.yml`: add a `services: postgres: image: postgres:16` block for the backend job; run pytest twice (once SQLite, once Postgres).

### G6.6 — Cutover script
- `backend/scripts/migrate_sqlite_to_postgres.py` already exists. Verify it copies cleanly into the freshly-Alembic'd schema.
- Document the production cutover playbook in `docs/postgres_migration.md` (already drafted; refresh once G6.1 lands).

**Verification**: backend passes the same 98+ tests against both SQLite and Postgres, in CI.

---

## G7 — Frontend test infrastructure (Playwright + axe-core + Vitest)

**Why**: zero frontend tests exist today. F9.1 (cross-browser),
F9.2 (a11y), F9.3 (Lighthouse) all reference Playwright / axe / Lighthouse
configurations that don't exist on disk.

**Owner**: frontend engineer · **Effort**: 2 days · **Blocker**: none

### G7.1 — Install + configure Playwright
- `cd frontend && npm install -D @playwright/test && npx playwright install --with-deps chromium webkit firefox`
- Author `frontend/playwright.config.ts` with three browser projects (chromium, webkit, firefox) at desktop + phone viewports.

### G7.2 — Port the 12-step protocol to Playwright
- One spec per phase: `frontend/tests/e2e/{enroll,verify,deepfake-lab,admin,i18n,mobile}.spec.ts`.
- Each step uses `test.step("...", ...)` so a partial failure surfaces the specific line.
- Use `expect(page).toHaveScreenshot(...)` for visual regression — bake the baselines on the first green run.

### G7.3 — axe-core integration
- `npm install -D @axe-core/playwright`
- New file `frontend/tests/e2e/axe.spec.ts` walks every screen, asserts zero serious or critical violations.

### G7.4 — Vitest unit tests for `lib/audio.ts` + `lib/format.ts`
- `npm install -D vitest happy-dom`
- New files `frontend/src/lib/audio.test.ts`, `frontend/src/lib/format.test.ts`.
- Cover: AudioWorklet load failure → ScriptProcessor fallback; locale-aware date formatting under en + he.

### G7.5 — Add to CI
- `.github/workflows/ci.yml` frontend job: add `npx playwright test` after the build step. Cache the browser binaries.

**Verification**: every screen has at least one passing E2E test + axe scan; CI's frontend job runs both on every PR.

---

## G8 — Lighthouse CI workflow

**Why**: `docs/qa.md` §F9.3 specifies budgets (LCP < 2 s, CLS < 0.10,
INP < 200 ms, bundle < 350 KB). Bundle-size is enforced. The other
three are documented but not measured automatically.

**Owner**: frontend engineer · **Effort**: 0.5 day · **Blocker**: none

### G8.1 — Author `.github/workflows/lighthouse.yml`
- Trigger: every PR.
- Steps: build the frontend, serve `dist/` on a port, run `treosh/lighthouse-ci-action` with the budget JSON.

### G8.2 — Author `frontend/lighthouse-budget.json`
- LCP, CLS, INP, JavaScript bytes, total bytes — same numbers as `docs/qa.md`.

### G8.3 — Wire to PR comment
- Use `peter-evans/create-or-update-comment` so the PR gets a delta-vs-main scorecard.

**Verification**: a deliberately bloated PR (e.g. import a 1 MB lib) fails the workflow with the specific budget that was breached.

---

## G9 — Real benchmark runs (paper-grade numbers)

**Why**: `docs/paper/evaluation.md` carries placeholder TODO cells for
EER on VoxCeleb1-O, ASVspoof2019 LA, and per-TTS-family detection rate.
The harnesses (`bench_eer_voxceleb.py`, `bench_spoof_detection.py`) are
written; the runs haven't happened.

**Owner**: ML engineer · **Effort**: 1 day (per benchmark, after dataset
download) · **Blocker**: G1 (real models) + dataset downloads + GPU
access

### G9.1 — VoxCeleb1-O EER
- Download `veri_test.txt` + the WAV corpus (~30 GB).
- `cd backend && .venv/bin/python scripts/bench_eer_voxceleb.py --pairs … --audio-root … --output docs/paper/results_eer.json`
- Update `docs/paper/evaluation.md` §F8.2 numbers table with the row.

### G9.2 — ASVspoof2019 LA EER
- Download the eval split + the protocol file.
- `cd backend && .venv/bin/python scripts/bench_spoof_detection.py --asvspoof-dir … --asvspoof-protocol … --output docs/paper/results_spoof.json`
- Update `docs/paper/evaluation.md` §F8.3.

### G9.3 — TTS-family detection rate
- Use `scripts/generate_clones.py` (G5.2) to produce the F5-TTS / XTTS / ElevenLabs corpora.
- Same command as G9.2 with `--clones-dir` populated.

### G9.4 — Latency on three machines
- Run `scripts/bench_latency.py --runs 1000` on each tier (laptop, server, kiosk).
- Update the table in `docs/paper/evaluation.md` §F8.4.

**Verification**: every TODO cell in `docs/paper/evaluation.md` has a
real number from a run committed to disk under `docs/paper/results_*.json`.

---

## G10 — Multi-user enrolment study

**Why**: F8.5. The published EER on VoxCeleb1-O is a single-language,
well-curated corpus that systematically over-states real-world
performance. The directorate's deployment will see real microphones,
real environments, and 50 % Hebrew speakers — none of which is in the
training distribution.

**Owner**: project lead (recruitment) + ML engineer (analysis) ·
**Effort**: 2 weeks elapsed time, 3 engineer-days analysis ·
**Blocker**: volunteers + IRB

### G10.1 — IRB / data-protection sign-off
- Project lead determines whether the study runs in an academic
  institution (full IRB required) or inside the customer's controlled
  environment with their internal review board.
- Draft `docs/paper/consent_form.md` covering: voice samples retained
  for the study only, deleted within 30 days, no third-party sharing.
- Sign-off from the relevant board.

### G10.2 — Recruit ≥ 20 volunteers
- Mixed gender. 10 native Hebrew + 10 native English (target).
- All adults (18+) with informed consent.

### G10.3 — Enrolment session
- Each volunteer records 3 enrolment samples (60 s prompt each).
- Operator runs the kiosk + records the session times.

### G10.4 — Verification trials
- ≥ 7 days after enrolment (rules out same-session bias).
- Each volunteer records 3 verification samples.

### G10.5 — Cross-impostor trials
- For each pair (i, j) with i ≠ j: run /verify with j's audio against i's enrolment.
- ~570 impostor trials for n=20.

### G10.6 — Compute FAR / FRR / EER
- New script `backend/scripts/bench_multiuser.py`.
- Plot FAR vs FRR; compute EER.
- Per-language breakdown (Hebrew vs English).

### G10.7 — Report
- Update `docs/paper/evaluation.md` §F8.5 with the numbers.
- Discuss any per-language gap > 1.5 percentage points in `docs/paper/discussion.md` §6.

**Verification**: §F8.5 of the evaluation doc has real EER + plot
attached, signed off by the project lead.

---

## G11 — Penetration test

**Why**: F9.4. No external review of the auth / admin / file-upload
attack surface. Required to claim "no outstanding High / Critical
findings" at the milestone-close gate.

**Owner**: project lead (booking) + security firm (execution) ·
**Effort**: 5 business days for the pentester + 2 days engineer
remediation per Critical/High · **Blocker**: pentest provider contract

### G11.1 — Book the pentester
- Project lead engages an external security firm. Budget: typically
  $15–40k for a 5-day engagement of this scope.
- Provide them: staging URL (isolated from production), a fresh
  `BIOVOICE_ADMIN_API_KEY`, a non-admin enrolment account.

### G11.2 — Hand over the scope document
- Already written: `docs/qa.md` §F9.4 + `docs/deployment.md` §Pentest scope.
- Hand it over verbatim.

### G11.3 — Engineer triage
- During the engagement: rapid-response to clarification questions.
- After: every Critical / High gets a same-week fix; Mediums get
  target-fix dates; Lows get acknowledged.

### G11.4 — Re-test
- Schedule a 30-day re-test against the patched codebase to verify
  every Critical / High closes.

### G11.5 — Sign-off
- Pentest report attached to the milestone-close gate.

**Verification**: re-test report shows zero outstanding Critical / High.

---

## G12 — Real-speaker acceptance test (10 native HE + 10 native EN)

**Why**: F9.5. Independent of the multi-user EER study (G10) — this
is the "Hebrew operator can use the kiosk end-to-end without an
English fallback" sign-off, not a research benchmark.

**Owner**: project lead · **Effort**: 1 day · **Blocker**: G3 (per-screen
i18n extraction) + G4 (Hebrew translation review) + volunteers

### G12.1 — Recruit
- 5 native Hebrew + 5 native English speakers.

### G12.2 — Run the protocol from `docs/qa.md` §F9.5
- Each enrols, verifies, and attempts a deepfake attack via DeepfakeLab.
- Capture verbal feedback in `docs/qa-feedback.md`.

### G12.3 — Pass criteria
- 10/10 successful enrolments (after at most one retry per sample).
- 10/10 successful own-voice verifications.
- 0/10 successful spoof attacks.
- Hebrew flow signed off by a native speaker.
- Average time-to-verify ≤ 30 s.

### G12.4 — Sign-off
- Project lead signs the milestone-close checklist.

**Verification**: sign-off recorded in `docs/qa-results-final.md`.

---

## G13 — Operator workflow polish (deployment-experience gaps)

**Why**: small papercuts that the deployment guide glosses over and that
will burn a fresh operator on first install.

**Owner**: backend engineer · **Effort**: 1 day · **Blocker**: none

### G13.1 — Build + push the Docker image to a registry
- The Dockerfile + compose file are written but never built.
- `docker build -f Dockerfile -t biovoice-backend:0.1.0 backend && docker push <registry>/biovoice-backend:0.1.0`
- Update `docker-compose.yml` to reference the registry image instead of building locally (faster operator install).

### G13.2 — End-to-end `docker compose up` smoke test
- Fresh checkout; `cp backend/.env.example backend/.env`; populate
  `BIOVOICE_ADMIN_API_KEY`; drop a TLS cert into `deploy/certs/`;
  `docker compose up -d`.
- Walk the 12-step protocol against `https://localhost`.
- Capture every fail and patch.

### G13.3 — Run the backup → restore round-trip
- `./deploy/backup.sh` against the running stack.
- Wipe the data volume (`docker compose down -v`).
- `./deploy/restore.sh` from the produced tarball.
- `docker compose up -d` again; verify enrolled users + verification
  history are intact.

### G13.4 — TLS provisioning recipe
- Add to `docs/deployment.md`: a concrete `certbot` command that
  drops the result into `deploy/certs/` with the right names. Currently
  documented at the abstract level only.

**Verification**: a fresh engineer can follow `docs/deployment.md`
end-to-end and stand up the kiosk in ≤ 2 hours.

---

## Cross-reference back to the original F-plan

| Original F-task | Coverage | Remaining gap |
|---|---|---|
| F1.4 XTTS install | Documented | XTTS-only path untested in CI; covered by G2.5 if exercised in browser |
| F2.1–F2.5 auth/sessions | ✅ done | none |
| F3.1–F3.3 audio | ✅ done | G2.5 (browser AudioWorklet verification) |
| F4 sub-classifier | Heuristic ✅, trained mode wired but no heads | G5 |
| F5 i18n + RTL + mobile | Wiring ✅, full extraction partial | G3, G4, G2.6 |
| F6 admin | Backend ✅, frontend just shipped | G2.7 |
| F7.1 Postgres | Plan + script ✅, store unimplemented | G6 |
| F7.2–F7.8 deploy | Wired, never run | G13 |
| F8.1, F8.6, F8.7 paper sections | ✅ done | none |
| F8.2, F8.3, F8.4 benchmarks | Harnesses ✅, runs pending | G9 |
| F8.5 multi-user study | Protocol ✅, run pending | G10 |
| F9.1 cross-browser | Protocol ✅, runs pending | G2, G7 |
| F9.2 a11y | Procedure ✅, axe scaffolding pending | G7 |
| F9.3 perf | Bundle budget ✅, Lighthouse pending | G8 |
| F9.4 pentest | Scope ✅, run pending | G11 |
| F9.5 acceptance | Protocol ✅, run pending | G12 |

---

## Effort + sequencing summary

| Block | Effort (engineer-days) | Blocker | Can start now? |
|---|---|---|---|
| G1 — wire real ML | 0.5 | — | ✅ |
| G2 — manual browser QA | 0.5 | G1 | after G1 |
| G3 — i18n extraction | 1.5 | — | ✅ |
| G4 — HE translation review | 0.5 contractor | contractor | needs booking |
| G5 — train probe heads | 5 | corpus | needs labelled data |
| G6 — PostgresStore | 3 | — | ✅ |
| G7 — frontend test infra | 2 | — | ✅ |
| G8 — Lighthouse CI | 0.5 | — | ✅ |
| G9 — real benchmarks | 1 per | G1 + datasets | needs datasets + GPU |
| G10 — multi-user study | 3 + 2 weeks elapsed | volunteers + IRB | needs recruitment |
| G11 — pentest | 5 days pentester + remediation | provider contract | needs booking |
| G12 — acceptance test | 1 | G3 + G4 + volunteers | needs G3 + G4 + volunteers |
| G13 — deploy polish | 1 | — | ✅ |

**Engineer-only critical path** (no external resource): G1 → G2 → G3 → G7 → G6 → G8 → G13 ≈ **9 engineer-days**.

**External-dependency tasks** (G4 / G5 / G9 / G10 / G11 / G12) gate the empirical claims and the acceptance sign-off; their engineering effort is small but the calendar time is dominated by waiting on humans + datasets + bookings.
