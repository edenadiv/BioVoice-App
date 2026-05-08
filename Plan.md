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

### Phase A — Foundations (parallel, both engineers, day 1) ✅

- **Y-12** ✅ Recorder hook — keystone; blocks every screen with a mic.
- **E-14** ✅ API client + state foundations — `getAvailability`, `spoofTest`, `lib/session.tsx`, `lib/thresholds.ts`, `lib/useResultsPolling.ts`, `lib/useCalibratedTimeline.ts`.
- **E-15** ✅ Strip mocks — delete `PROFILES`, `ExplainScreen`, `'explain'` order entries, `seedActivity`/`makeRandomActivity`.
- **E-16** ✅ Real counters + activity feed.
- **Y-17** ✅ Backend `GET /users/{user_id}/availability`.
- **Y-19** ✅ `analysis_details_from_score()` deterministic derivation.

### Phase B — Verification flow (day 2) ✅

- **E-17** ✅ Implicit-login Run Verification.
- **E-18** ✅ Rebuild `VerificationOverlay` around the calibrated timeline.
- **Y-13** ✅ Wire `EnrollScreen` (depends on Y-12 + Y-17).
- **Y-14** ✅ Wire `ProcessingScreen`.
- **Y-18** ✅ Backend `POST /me/spoof/test`.
- **E-20** ✅ Wire `ProfilesPage` + inline enroll dialog.

### Phase C — Result & lab (day 3) ✅

- **E-19** ✅ Wire `VerifyScreen` to `state.lastVerification`.
- **Y-15** ✅ Wire `DeepfakeScreen`.
- **Y-16** ✅ Wire `DeepfakeLab` (depends on Y-18).
- **Y-20** ✅ Mic-permission denial UX (`MicDeniedCallout` wired into Enroll/Dialog/Overlay).

### Phase D — QA & ship (day 4) 🟡 (manual run-through pending real-mic test)

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

- [ ] LAN-IP CORS for phone demos: do we want a `CORS_ORIGINS` env-var override now, or post-milestone?
- [ ] Should the activity feed include enrollments, or stay verifications-only? (Currently /results is verify-only.)
- [ ] Will Idan rejoin? If yes, he picks up the LAN-CORS env override + extra QA pass.
