# BioVoice — Wire-Live Migration Plan

> **Status legend:** ⬜ pending · 🟡 in progress · ✅ done · ⛔ blocked
> **Last updated:** 2026-05-08
> **Owner of this file:** Eden (UI lead — keeps it updated as phases progress)
> **Source of truth for the UI:** the kiosk prototype currently in `frontend/src/` (`app.jsx`, `audio.jsx`, `screens.jsx`, `console.jsx`, `console-ext.jsx`, `more-screens.jsx`, `visuals.jsx`). The SDD-6 PDF (`docs/SDD-6 Riva.pdf`) figures §5 are reference-only — the previous plan to rebuild from those figures was a misread (see `MIGRATION_POSTMORTEM.md`).

---

## 1. Goals

The kiosk prototype is in `main` and renders correctly with mock data. For the Israel National Cyber Directorate evaluation and the supporting research paper, **every number on screen must come from the live FastAPI backend**:

- No hardcoded `PROFILES`.
- No `Math.random()` similarity / deepfake scores.
- No drift counters.
- No animated stubs that pretend to be ML inference.

Acceptance bar (per SDD §1.5):

- End-to-end verify p95 < 2 s wall-clock.
- 16 kHz mono WAV, 1 – 10 s recordings.
- Decision logic: `ACCEPT = (similarity ≥ 0.75) ∧ (deepfake_score ≥ 0.5)`.

## 2. Team

Two-person team. Eden is UI lead + verification side; Yoav is audio + active screens + the two pending backend routes.

| Member | Owns this milestone |
|---|---|
| **Eden Adiv** | API client + state foundations, strip mocks, real counters/feed, implicit-login Run Verification, overlay reconcile, VerifyScreen, ProfilesPage, plan upkeep. |
| **Yoav Zucker** | Recorder hook (the keystone), EnrollScreen, ProcessingScreen, DeepfakeScreen, DeepfakeLab, two pending backend routes (availability + spoof-test), AASIST sub-score derivation, mic-permission UX. |

## 3. Scope (in / out)

**In scope (this milestone):**

- Wire every kiosk screen to the live FastAPI backend.
- Add the two pending backend routes: `GET /users/{user_id}/availability`, `POST /me/spoof/test`.
- Replace placeholder AASIST sub-scores with deterministic seeded derivation.
- Preserve the existing kiosk visual language. **No visual rebuild.**

**Out of scope:**

- TCAV / ExplainScreen — explicitly dropped. Strip from the navigation graph in this milestone.
- Multi-tenant admin views, audit-log viewer.
- i18n / Hebrew RTL.
- Settings persistence (operator preferences in `UserSettingsPage` stay UI-only).
- macOS-window rebuild from SDD §5 figures — abandoned (see `MIGRATION_POSTMORTEM.md`).

## 4. User-confirmed decisions

- **Login flow:** implicit via Run Verification. `POST /auth/login` both verifies and creates the session — no separate login modal.
- **Empty-DB state:** honest zeros + onboarding banner ("No enrolled profiles yet. Click '+ ENROLL NEW' in Profiles."). No demo-data seeding.
- **DeepfakeLab attack tiles:** hide replay/splice (unimplemented). Show only the working clone tile.

## 5. Architectural decisions

1. **No file/folder reorg.** The `.jsx` files stay where they are. New `.ts/.tsx` helpers (`lib/audio.ts`, `lib/session.tsx`, `lib/thresholds.ts`, `lib/useResultsPolling.ts`, `lib/useCalibratedTimeline.ts`) sit alongside `lib/api.ts` and `lib/wav.ts`.
2. **One context, no Redux.** `lib/session.tsx` holds `{ session, speakers, results, lastVerification, lastSpoof, flow }`. Each screen reads via `useAppState()`.
3. **WAV recorder is segregated.** `useMicrophone` + `useSyntheticAudio` (in `audio.jsx`) stay for **visualization only**. The new `useVoiceRecorder` (`lib/audio.ts`, Y-12) is the **only** producer of `File` blobs sent to the backend; it refuses to start without a real `MediaStream`. Synthetic audio never reaches the server.
4. **Decision lives on the server.** Frontend reads `result.decision` directly. `lib/thresholds.ts` mirrors `backend/app/core/config.py` thresholds for **display only** (gauge marker labels). The frontend never re-derives `accepted = sim ≥ 0.75 && df ≥ 0.5`.
5. **Calibrated timelines, not random ones.** `useCalibratedTimeline(promise, expectedTotalMs)` drives both `ProcessingScreen` stages and `VerificationOverlay` phases. Animations hold the final stage until the promise resolves; > 4 s switches to "Still working…".
6. **Polling, not websockets.** `useResultsPolling(5000)` calls `listResults()` every 5 s with `AbortController` cleanup + exponential backoff on error. Drives counters + activity feed.

## 6. Phased rollout

### Phase A — Foundations (parallel, both engineers, day 1) ⬜

- **Y-12** Recorder hook — keystone; blocks every screen with a mic.
- **E-14** API client + state foundations — `getAvailability`, `spoofTest`, `lib/session.tsx`, `lib/thresholds.ts`, `lib/useResultsPolling.ts`, `lib/useCalibratedTimeline.ts`.
- **E-15** Strip mocks — delete `PROFILES`, `ExplainScreen`, `'explain'` order entries, `seedActivity`/`makeRandomActivity`.
- **E-16** Real counters + activity feed.
- **Y-17** Backend `GET /users/{user_id}/availability`.
- **Y-19** `analysis_details_from_score()` deterministic derivation.

### Phase B — Verification flow (day 2) ⬜

- **E-17** Implicit-login Run Verification.
- **E-18** Rebuild `VerificationOverlay` around the calibrated timeline.
- **Y-13** Wire `EnrollScreen` (depends on Y-12 + Y-17).
- **Y-14** Wire `ProcessingScreen`.
- **Y-18** Backend `POST /me/spoof/test`.
- **E-20** Wire `ProfilesPage` + inline enroll dialog.

### Phase C — Result & lab (day 3) ⬜

- **E-19** Wire `VerifyScreen` to `state.lastVerification`.
- **Y-15** Wire `DeepfakeScreen`.
- **Y-16** Wire `DeepfakeLab` (depends on Y-18).
- **Y-20** Mic-permission denial UX.

### Phase D — QA & ship (day 4) ⬜

- **E-21** Cross-screen manual run-through (see §9 below) + Plan.md status update.
- Backend pytest stays green.
- Both engineers review each other's PRs end-to-end. UI PRs require a screenshot; backend PRs require a curl/pytest snippet.

## 7. Repo layout (after this milestone)

```
frontend/src/
  main.tsx                 # imports ./app.jsx (no change)
  app.jsx                  # state-machine entry — uses session context
  audio.jsx                # visualization hooks (Mic, Synthetic) — NO recorder
  screens.jsx              # WelcomeScreen, EnrollScreen, ProcessingScreen,
                           #   VerifyScreen, DeepfakeScreen, Chrome
                           # ExplainScreen DELETED
  console.jsx              # ConsoleScreen, SettingsPanel, ParticleFlow, useCounter
  console-ext.jsx          # AmbientField, EmbeddingConstellation, LiveFeatures,
                           #   LiveClock, ThreatLevel, VerificationOverlay (rebuilt)
  more-screens.jsx         # Sidebar, DeepfakeLab, UserSettingsPage, ProfilesPage
  visuals.jsx              # VoiceOrb, Waveform, MelSpectrogram, etc.
  lib/
    api.ts                 # +getAvailability, +spoofTest
    audio.ts               # NEW (Y-12) — useVoiceRecorder
    session.tsx            # NEW (E-14) — context + provider + hooks
    thresholds.ts          # NEW (E-14) — SIM_THRESHOLD, DF_THRESHOLD
    useResultsPolling.ts   # NEW (E-14)
    useCalibratedTimeline.ts # NEW (E-14)
    wav.ts                 # unchanged
  types.ts                 # +SpoofTestResult

backend/app/
  api/routes.py            # + GET /users/{user_id}/availability  (Y-17)
                           # + POST /me/spoof/test                (Y-18)
  services/
    detector.py            # + analysis_details_from_score()      (Y-19)
    verification.py        # uses Y-19 instead of placeholder mirror

backend/tests/
  test_users.py            # NEW (Y-17)
  test_spoof.py            # NEW (Y-18)
  test_verification.py     # unchanged from PR #6
```

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Synthetic audio fallback (`useSyntheticAudio`) accidentally feeding the backend. | Hard segregation — `useVoiceRecorder` (Y-12) refuses to start without a real `MediaStream`; visualization hooks have no WAV path. |
| Network slowness vs the calibrated timeline. | `useCalibratedTimeline` switches to "Still working…" after 4 s; same hook for `ProcessingScreen` + `VerificationOverlay`. |
| XTTS unavailability for `/me/spoof` (HTTP 503). | `DeepfakeLab` catches 503 explicitly with an inline banner. Test Detection still works against any uploaded WAV. |
| LAN-IP CORS for phone demos (`config.py:13` is hardcoded to `localhost:5173`). | Document `CORS_ORIGINS` env-var override as a follow-up; do not ship in this milestone. |
| `lastVerification` is null when user navigates directly to a result screen. | Result-screen mounts check the context; redirect to Console if null. No stub rendering. |
| Two-person team / single-reviewer PRs. | Both engineers review every PR end-to-end. UI PRs require a screenshot; backend PRs require a curl/pytest snippet. (Standing rule from `MIGRATION_POSTMORTEM.md`.) |
| Build green ≠ app works. | Every UI PR must include a headless render check (puppeteer / `Chrome --screenshot`) confirming no `pageerror`. (Standing rule from `MIGRATION_POSTMORTEM.md`.) |

## 9. Verification (end-to-end manual run-through)

Run `uvicorn app.main:app --reload` in `backend/` and `npm run dev` in `frontend/`. With both up:

1. **Backend smoke** — `curl http://localhost:8000/health` → `{"status":"ok"}`. `curl http://localhost:8000/users` → `[]` on a fresh DB.
2. **Console empty state** — open `http://localhost:5173`. Expect `verifyCount=0`, `threatCount=0`, empty activity feed, onboarding banner.
3. **Real enrollment (3 samples)** — Profiles → "+ ENROLL NEW" → username `eden_test` → record three 4-second WAVs. Card shows `sampleCount: 3` with real `enrolledAt`.
4. **Implicit-login + ACCEPT** — Console → pick `eden_test` → Run Verification → record. Overlay snaps to phase 3 with real similarity ≥ 0.75 and df ≥ 0.5. `VerifyScreen` shows the same numbers and real `stageBreakdown.totalMs`.
5. **REJECT (mismatch)** — enrol second user; while logged in as the first, verify with the second's voice. Overlay shows red, `decisionReason: 'mismatch'`.
6. **DEEPFAKE** — DeepfakeLab → pick reference sample → Generate → Test Detection → verdict `decision: 'FAKE'`. Feed the generated WAV through `/me/verify` → `decision: 'DEEPFAKE'`.
7. **Activity feed** — console shows the 4 events. Counters: `verifyCount=2`, `threatCount=1`. Refresh — counters persist (sourced from `/results`).
8. **Latency budget** — devtools Network: `/me/verify` p95 < 2 s over 10 runs.
9. **No leaked mocks** — `grep -nE "Math.random\(\)" frontend/src/*.jsx` returns only ambient/visual jitter (e.g. `console-ext.jsx:22-27` particles), nothing in business logic.
10. **Backend tests** — `cd backend && pytest` green, including new `test_users.py` and `test_spoof.py`.
11. **No console errors** — devtools console clean across every screen + verification flow.
12. **Permission denial** — disable mic; refresh; expect inline "Microphone access required" with Retry button (Y-20). Synthetic audio never POSTs.

## 10. Communication

- Daily 5-minute stand-up in Slack/WhatsApp: shipped, in flight, blockers.
- Status updates land in this `Plan.md` checkbox grid (mark phase status as you go).
- PRs target `main` via topic branches, one per task or small group of tasks.
- The other engineer is the required reviewer.

## 11. Open questions

- [ ] LAN-IP CORS for phone demos: do we want a `CORS_ORIGINS` env-var override now, or post-milestone? *(scheduled for E2.2)*
- [ ] Should the activity feed include enrollments, or stay verifications-only? (Currently /results is verify-only.)
- [ ] Will Idan rejoin? If yes, he picks up the LAN-CORS env override + extra QA pass.

---

## 12. Forward execution (post wire-live milestone)

> **Status legend:** ⬜ pending · 🟡 in progress · ✅ done · ⛔ blocked
> Each step lists concrete sub-actions and a verification block. Verification = the artifact or command that proves the step landed correctly.

### 12.0 Decisions in flight (defaults locked unless overridden)

- **Merge order:** sequential, in the order listed in 12.E1.1. Batching is riskier; one bad PR poisons the rest.
- **XTTS approach:** Option 1 (real install + model weights) **and** Option 2 (bundled fallback WAV). Belt-and-braces.
- **Demo seeding:** off by default; behind `BIOVOICE_SEED_DEMO=1` env var. Honest empty state for normal use; populated for client visits only.
- **Research-paper format:** Markdown drafts in `docs/paper/`, converted to LaTeX at the end.
- **Yoav availability:** Eden continues solo through E2; Yoav absorbs E4 backlog if he returns.

A "Decisions to confirm" checklist sits at §12.5 — Eden should explicitly OK before E2.1 begins, defaults applied otherwise.

---

### 12.E1 — Land the stack & verify (target: today) ⬜

#### 12.E1.1 Sequential merge of the 6 PRs

**Sub-actions** (in order; each merge syncs `main` before the next):

1. Open `pull/new/feat/yoav-backend-completion` → review → squash & merge.
2. `git fetch origin --prune && git checkout main && git pull --ff-only`.
3. Merge `feat/eden-profiles-enroll` → sync.
4. Merge `feat/eden-yoav-result-screens` → sync.
5. Merge `feat/yoav-deepfake-lab` → sync.
6. Merge `feat/yoav-enroll-screen` → sync.
7. Merge `feat/yoav-processing-and-polish` → sync.
8. Delete each merged topic branch locally + on origin.

**Verification**

- After every merge: `cd backend && .venv/bin/python -c "from app.main import app; print(len(app.routes))"` returns ≥ 16.
- After every merge: `cd backend && .venv/bin/pytest tests/ -q` → 26 passed.
- After every merge: `cd frontend && npm run build` → green.
- After every merge: headless render check (`node /tmp/capture_errors.js`) → zero `pageerror`.
- After step 7: `git log --oneline -10` shows all six feat-merge commits in `main`.

#### 12.E1.2 Manual QA protocol (real-mic, two-user)

The 12-step protocol from §9, executed against `localhost` with both servers up.

**Sub-actions**

1. Start backend: `cd backend && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000`.
2. Start frontend: `cd frontend && npm run dev -- --host 0.0.0.0 --port 5173`.
3. Console empty-state: counters `0`/`0`, "NO ACTIVITY YET" nudge.
4. Profiles → "+ ENROLL NEW" → `eden_test` → 3 × 4 s samples → card shows `sampleCount: 3`.
5. Console → pick `eden_test` → press `V` → speak ~3 s → overlay phase 3 with similarity ≥ 0.75, dfScore ≥ 0.5, decision = ACCEPT, real `stageBreakdown.totalMs`, real `sessionId`.
6. Enrol `bob_test`. While `eden_test` is logged in, click `bob_test` → verify with `eden_test`'s voice → REJECT with `decisionReason: 'mismatch'`.
7. DeepfakeLab → Generate (likely 503 until E2.1) → Test Detection on any uploaded WAV.
8. Activity feed shows 3 events; counters reflect real ACCEPT/DEEPFAKE counts.
9. Refresh browser → counters persist (from `/results`).
10. Devtools Network: `/me/verify` p95 < 2 s over 10 runs.
11. `grep -nE "Math\.random\(\)" frontend/src/*.jsx` only matches ambient/visual jitter.
12. Devtools console: clean across every screen.

**Verification**

- Every step green, OR one issue filed per defect.
- Update §6 Phase D status: 🟡 → ✅ once every step passes.

---

### 12.E2 — Demo readiness (target: 2–3 days post-E1) ⬜

#### 12.E2.1 Re-enable XTTS for spoof generation

`POST /me/spoof` returns 503 today. The DeepfakeLab is the marquee demo screen.

**Sub-actions**

1. Add `backend/scripts/setup_xtts.sh` — downloads XTTS-v2 weights into `XTTS-v2/` (matches `core/config.py:xtts_model_path`).
2. Update `backend/README.md` with `bash scripts/setup_xtts.sh && .venv/bin/pip install 'TTS>=0.22,<0.23'`.
3. Add `XTTS-v2/` to root `.gitignore`.
4. Bundle `backend/data/fallback_spoof.wav` (~50 KB committed). Add `BIOVOICE_FALLBACK_SPOOF=1` env var.
5. Update `services/spoof.py` to honour the env var when XTTS deps are missing.
6. Pytest in `backend/tests/test_spoof.py` for the fallback path.

**Verification**

- After `setup_xtts.sh`: `curl -F text="hello" -F language=en -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:8000/me/spoof -o /tmp/out.wav` → 200 + non-empty WAV.
- DeepfakeLab "Forge & test attack" produces audible speech; "Test Detection" returns `decision: 'FAKE'`.
- Without XTTS + `BIOVOICE_FALLBACK_SPOOF=1`: same endpoint returns the bundled fallback.
- `pytest backend/tests/test_spoof.py` → green.

#### 12.E2.2 LAN-IP CORS override

**Sub-actions**

1. Edit `backend/app/core/config.py` — read `CORS_ORIGINS` (comma-separated) from env, fallback to `["http://localhost:5173"]`.
2. Document in `backend/README.md`.
3. Pytest covering env-var → settings flow.
4. Append §11 follow-up note: post-demo, replace env-var with config-file or operator-settings UI.

**Verification**

- Start backend with `CORS_ORIGINS=http://localhost:5173,http://10.0.0.10:5173`.
- Phone @ `http://10.0.0.10:5173` loads, devtools Network shows `Access-Control-Allow-Origin` matches origin, counters render.

#### 12.E2.3 Demo data seeding (env-gated)

**Sub-actions**

1. Add `backend/scripts/seed_demo.py` — enrols two bundled WAVs (`backend/data/demo/alice.wav`, `bob.wav`) idempotently.
2. Wire into `backend/app/main.py` startup if `BIOVOICE_SEED_DEMO=1` and store is empty.
3. Bundle the two ~3 s 16 kHz WAVs (~100 KB each).
4. Document in `backend/README.md`.

**Verification**

- `BIOVOICE_SEED_DEMO=1` against empty SQLite → `/users` returns 2 entries with `sampleCount: 3`.
- Restart without env var → still 2 entries (idempotent).
- Clear DB, restart without env → empty list (no surprise mock data).

#### 12.E2.4 Latency probe + paper evidence

**Sub-actions**

1. Run `cd backend && .venv/bin/python scripts/bench_verify.py --user alice_demo --token <token> --wav backend/data/demo/alice.wav --runs 50`.
2. Capture p50, p95, max, per-stage means.
3. Append numbers to §8 risks table under the "< 2 s budget" row.

**Verification**

- p95 < 2000 ms.
- Numbers committed to §8.

---

### 12.E3 — Research-paper evidence (target: 1 day after E2) ⬜

Drafts in Markdown under `docs/paper/`; LaTeX conversion is the deliverable after this plan.

#### 12.E3.1 `docs/paper/performance.md`
- Embed E2.4 bench output (p50/p95/max + stage_breakdown).
- Note cold-start penalty (first verify after server boot).

**Verification:** file exists, numbers reference the actual `bench_verify.py` output committed in E2.4.

#### 12.E3.2 `docs/paper/decision_logic.md`
- Pull from `services/verification.py:_decide` (SDD §2.5 alignment).
- Reference the 12 verification pytests as evidence.

**Verification:** every claim has a code reference (`services/verification.py:NN`).

#### 12.E3.3 `docs/paper/analysis_details.md`
- Quote the docstring of `services/detector.py:analysis_details_from_score`.
- Document the seeded RNG construction (`hashlib.sha256(audio_hash)[:4] → random.Random`) and the ±0.02 jitter bound.
- Note future work: replace with native AASIST sub-classifier outputs.

**Verification:** transparent about the derivation. Future work has concrete file path + function name.

#### 12.E3.4 `docs/paper/testing.md`
- Enumerate all 26 pytests grouped (verification / users / spoof / sub-score derivation).
- Reference `MIGRATION_POSTMORTEM.md` for the "build green ≠ app works" + screenshot rules.
- Cite `bench_verify.py` for latency methodology.

**Verification:** all 26 test functions enumerated, group counts correct.

#### 12.E3.5 `docs/paper/biovoice-paper.md`
- Stitch the four appendices into a single paper draft.
- Cite SDD-6 (`docs/SDD-6 Riva.pdf`) for architecture diagrams.
- Ship a PR; co-author review.

**Verification:** single Markdown rendering cleanly; reviewers approve.

---

### 12.E4 — Hardening backlog (post-demo) ⬜

Not blocking the milestone. Schedule after the client demo.

| Item | Why | Trigger | Effort |
|---|---|---|---|
| Session expiry + refresh | `auth_service.get_session` never expires (`backend/app/services/auth.py`) | Security review | 2 h |
| Rate-limit `/auth/login` | Brute-force surface; 5 attempts / 5 min / `user_id` | Security review | 2 h |
| Stable session-id | `result_id[-4:]` collides; switch to monotonic counter + date prefix | First post-demo collision | 1 h |
| AudioWorklet replaces ScriptProcessor | `lib/audio.ts` uses deprecated node | When deprecation forces it | 3 h |
| Loading skeletons | Profiles/Console flashes empty-state on first fetch | UX polish | 1 h |
| Strip dead props | `audio` prop in `DeepfakeLab` unused after Y-16; `seedRand` import in `screens.jsx` post-Y-14 | Code review | 30 min |
| Mobile responsive | 1920×1080 stage scales but chrome doesn't reflow on phones | Mobile demo request | 4 h |
| Real AASIST sub-classifier | Replace seeded jitter with native model outputs | Model team produces it | TBD |

Each item ships its own PR with a targeted test, screenshot (UI), or curl/pytest snippet (backend).

---

### 12.E5 — Out of scope, on the radar ⬜

Tracked here so they don't get re-asked.

- **TCAV** — explicitly dropped per §3 + `MIGRATION_POSTMORTEM.md`. Revisit only if explainability pipeline produces working concept activations. Hidden behind feature flag `BIOVOICE_ENABLE_TCAV` if revived.
- **Settings persistence** — `UserSettingsPage` is UI-only. Add `/me/settings` endpoint + JSON schema if operator preferences become real.
- **Multi-tenant admin views** — audit log viewer, per-user permissions, profile deletion.
- **i18n / Hebrew RTL** — non-trivial because the kiosk uses absolute positioning. Plan a CSS rework before tackling.
- **Replay/splice attack tiles in DeepfakeLab** — currently hidden. Bring back when backend grows handling.

---

### 12.5 Decisions to confirm before E2 starts

Eden should explicitly OK; defaults below if no objection.

1. **XTTS approach** — Option 1 + Option 2 (real install + fallback). *(Default OK?)*
2. **Demo seeding** — env-gated, off by default, two bundled users. *(Default OK?)*
3. **Bundled WAV identities** — whose voices in `alice.wav` / `bob.wav`? Suggest team voices.
4. **Paper format** — Markdown drafts → LaTeX final. *(Default OK?)*
5. **Yoav availability** — if back, owns AudioWorklet migration + reviews E2.1.

If all five default, the plan is unblocked from "merge done" → "demo-ready" without further checkpoints.

---

### 12.6 End-to-end milestone-close checklist

Closing the milestone requires every check below to be green.

1. `cd backend && .venv/bin/pytest tests/ -q` → ≥ 27 passed (26 existing + new fallback test).
2. `cd frontend && npm run build` → exit 0.
3. `node /tmp/capture_errors.js` → no `pageerror`.
4. Manual run-through (12.E1.2) with two real users + a real microphone → every step green.
5. `bench_verify.py --runs 50` p95 < 2000 ms.
6. DeepfakeLab generates real spoof audio (XTTS) AND `decision: 'FAKE'` AASIST verdict.
7. Phone @ `http://10.0.0.10:5173` loads + makes API calls without CORS error.
8. `BIOVOICE_SEED_DEMO=1` startup populates two demo users; without the env var, an empty DB stays empty.
9. `docs/paper/biovoice-paper.md` exists with all four appendices.
10. §6 Phase A/B/C/D ✅; §12 phases E1/E2/E3 ✅.
