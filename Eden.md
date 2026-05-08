# Eden — Tasks

> Owner: Eden Adiv. Cross-references `Plan.md` (master plan).
> **Role on this milestone:** UI lead + verification side. Owns API client + state foundations, the strip-mocks pass, real counters/feed, the implicit-login Run-Verification flow, the rebuilt `VerificationOverlay`, the `VerifyScreen` wiring, the `ProfilesPage` wiring, and `Plan.md` upkeep.

> **Status legend:** ⬜ pending · 🟡 in progress · ✅ done · ⛔ blocked

---

## Completed in earlier milestones

These shipped in PRs #5 and #6 and **stay** as the live backend / api-client baseline. They are not redone in this milestone.

- **E-1** ✅ Phase 0 audit (frontend + backend boot)
- **E-7** ✅ `VerificationResponse` extensions: `decision_reason`, `session_id`, `stage_breakdown`, `analysis_details`
- **E-8** ✅ `GET /me/verifications/{result_id}`
- **E-9** ✅ Decision logic alignment with SDD §2.5 (copy-locked messages, decision_reason enum)
- **E-10** ✅ 12 verification pytests
- **E-11** ✅ `backend/scripts/bench_verify.py` p50/p95 probe

The macOS-window screens from the previous plan (E-2 design system, E-3 app shell, E-4 Home/Login, E-5 Verification Result) are **superseded**. The kiosk prototype is the UI; see `MIGRATION_POSTMORTEM.md`.

---

## This milestone (Wire-Live)

### Sprint A — Foundations (day 1)

#### E-14 — API client + state foundations ⬜

- `lib/api.ts`: add two wrappers.
  ```ts
  getAvailability(userId: string): Promise<boolean>            // GET /users/{userId}/availability
  spoofTest(sessionToken: string, file: File): Promise<{
    deepfakeScore: number; decision: "FAKE" | "GENUINE";
    analysisDetails: AnalysisDetails;
  }>                                                            // POST /me/spoof/test
  ```
- `types.ts`: add `SpoofTestResult` + `SpoofDecision = "FAKE" | "GENUINE"`.
- `lib/session.tsx` (NEW): React context with `{ session, speakers, results, lastVerification, lastSpoof, flow: { intent: 'enroll' | 'verify' | null, pendingPromise: Promise<any> | null } }`. Provides `useAppState()` and `useAppDispatch()`. Hydrates `session.sessionToken` from `localStorage` on mount; restores via `getSession`.
- `lib/thresholds.ts` (NEW): `SIM_THRESHOLD = 0.75`, `DF_THRESHOLD = 0.50`. Comment: *"Display only. Source of truth = `backend/app/core/config.py:11-12`."*
- `lib/useResultsPolling.ts` (NEW): polls `listResults()` every 5 s with `AbortController` cleanup + exponential backoff (5s → 10s → 20s, cap 30s).
- `lib/useCalibratedTimeline.ts` (NEW): `(promise, { stages, expectedTotalMs, slowAfterMs }) → { activeIdx, progress, isSlow, settled }`. Drives stages over `expectedTotalMs`; final stage holds 95 % until promise resolves; flips `isSlow=true` after `slowAfterMs`.

**Definition of done:** `npm run build` green; smoke test the context with a temporary `?devstate=1` route that prints `state.results.length`.

#### E-15 — Strip PROFILES + ExplainScreen ⬜

- Delete `PROFILES` const at `app.jsx:12-19`.
- Delete `ExplainScreen` import at `app.jsx:7`; `case 'explain':` at `app.jsx:164-165`; `'explain'` entry from order arrays at `app.jsx:55, 92, 96, 198`.
- Delete `ExplainScreen` function (`screens.jsx:719-820`) and remove from exports (`screens.jsx:822-825`). Also remove unused `ConceptBars` if no other importer.
- Replace any `PROFILES`-driven dropdowns with `useAppState().speakers` (populated by `listSpeakers()` on mount in the context).
- Verify: `grep -rE "PROFILES|ExplainScreen" frontend/src/` returns nothing.

**Definition of done:** build green; kiosk renders without `PROFILES`; navigation no longer surfaces Explain.

#### E-16 — Real counters + activity feed ⬜

- Mount `useResultsPolling(5000)` once in `<AppStateProvider>`.
- Replace `verifyCount`/`threatCount` derivation in `app.jsx`:
  ```
  verifyCount = results.filter(r => r.decision === 'ACCEPT').length
  threatCount = results.filter(r => r.decision === 'DEEPFAKE').length
  ```
  Drop the `setInterval` drift at `app.jsx:70-76` and the initial values `2147` / `38` at `app.jsx:30-31`.
- Replace `seedActivity` / `makeRandomActivity` (`console.jsx:560-582`) with `state.results.slice(0, 10)`. Map `decision === 'ACCEPT' → 'accept'`, `'REJECT' → 'reject'`, `'DEEPFAKE' → 'deepfake'`. Drop the `'enroll'` activity kind for this milestone.
- `useCounter` (`console.jsx:12-28`) animation hook stays; it animates from 0 to whatever the derived count is on each results update.

**Definition of done:** counters and feed both reflect real `/results`; on a fresh DB, console shows zeros + onboarding banner; new verifications appear within 5 s.

### Sprint B — Verification flow (day 2)

#### E-17 — Implicit-login Run Verification ⬜

- Rewrite `runVerification(profile)` in `app.jsx:99-117`:
  1. If `state.session === null`: call `loginWithVoice(profile.userId, file)` (file from Y-12 recorder). On success store `session` in context + `localStorage`, push `verification` into `state.lastVerification`.
  2. If `state.session !== null` and `session.userId === profile.userId`: call `verifyAuthenticatedSpeaker(session.sessionToken, file)`.
  3. If `state.session !== null` and `session.userId !== profile.userId`: log out the current session (`logoutSession`) then go to (1).
- Set `state.flow.pendingPromise = thePromise` so `VerificationOverlay` (E-18) and `ProcessingScreen` (Y-14) can read it.
- On success: set `state.lastVerification` and optimistically prepend the new result to `state.results` (counters update immediately; polling reconciles 5 s later).
- On error: set `state.flow.pendingError = err.message`. Overlay renders an error panel (E-18).

**Definition of done:** clicking Run Verification on the console drives a real `/auth/login` (or `/me/verify` if session exists), the overlay shows real numbers, and the activity feed updates.

#### E-18 — Rebuild VerificationOverlay timeline ⬜

- File: `console-ext.jsx:401-537`. Drop the existing `useEffect`-based `[1700, 1500, 1500, 4000]` ms phase timer at `console-ext.jsx:405-436`.
- Use `useCalibratedTimeline(state.flow.pendingPromise, { stages: 3, expectedTotalMs: 1500, slowAfterMs: 4000 })`.
  - Phases 0 (Capture), 1 (Embed), 2 (Match) animate to ~95 % over 1.5 s.
  - Phase 3 (Result) does NOT mount until the promise settles.
  - If promise resolves during phases 0-2: snap to phase 3.
  - If `> 4 s`: copy on the bottom progress bar flips to "Still working…" and the bar holds at 90 %.
  - On error: phase 3 mounts an error panel using `result.message` (and a Close button). Same colour treatment as the existing red panel.
- Replace the hardcoded `passing = similarity >= 0.75 && dfScore >= 0.50` calc (`console-ext.jsx:438`) with `result.decision === 'ACCEPT'`.
- The 0.75 / 0.50 markers come from `lib/thresholds.ts` (display only).

**Definition of done:** at backend p50 (~1.4 s) the overlay feels calm and lands at the real numbers; at 5 s it switches to "Still working…"; on a 4xx/5xx response it shows the server's `message` in the error panel.

#### E-20 — Wire ProfilesPage + inline enroll ⬜

- File: `more-screens.jsx:534-590`.
- Replace `PROFILES` map with `state.speakers` (loaded once via `listSpeakers()` in the context provider).
- Per-card stats:
  - VERIFIED count = `state.results.filter(r => r.userId === speaker.userId && r.decision === 'ACCEPT').length`.
  - ENROLLED date = `formatDistanceToNow(speaker.enrolledAt)`.
  - QUALITY = drop or replace with `${speaker.sampleCount}/3 samples`.
- "+ ENROLL NEW" button at `more-screens.jsx:548` opens an inline modal/dialog:
  - Username input + `getAvailability` debounced 300 ms (Yoav-owned API call).
  - Y-12 recorder.
  - Three sequential samples, calling `enrollSpeaker(userId, file)` (or `enrollAuthenticatedSpeaker` if a session exists).
  - On the third sample, refetch `listSpeakers()` and close the modal.
- Strip `Math.floor(120 + Math.random() * 600)` etc. at `more-screens.jsx:580-583`.

**Definition of done:** Profiles page shows real speakers from `/users`; the enroll dialog runs an actual 3-sample flow against the backend; refresh persists.

### Sprint C — Result screen + QA (days 3–4)

#### E-19 — Wire VerifyScreen ⬜

- File: `screens.jsx:427-508`.
- Read `state.lastVerification` instead of receiving `similarity` / `dfScore` props.
- Replace the four hardcoded `val:` values for the artifact rows (`screens.jsx:608-611`) with:
  ```
  voiceNaturalness, spectralConsistency, temporalPatterns, artifactDetection
  ```
- Replace hardcoded `'1.27 s'` Stat with `${(stageBreakdown.totalMs / 1000).toFixed(2)} s`.
- Decision banner uses `result.decision === 'ACCEPT'`. Subline uses `result.message`.
- If `state.lastVerification === null` on mount, redirect to `console`.

**Definition of done:** the screen is a pure render of the response; no random fallbacks; matches the overlay's numbers exactly.

#### E-21 — QA pass + Plan.md upkeep ⬜

- Run the 12-step verification protocol from `Plan.md` §9.
- For any drift, file a follow-up issue or fix inline.
- Mark Phase A/B/C/D as ✅ in `Plan.md` as they land.
- Confirm `grep -nE "Math.random\(\)" frontend/src/*.jsx` only matches ambient/visual jitter (no business logic).

**Definition of done:** all 12 protocol steps green; backend pytest green; one screenshot per screen attached to the final QA PR description.

---

## Files Eden owns

**Frontend (existing):**

- `frontend/src/app.jsx` — E-15, E-16, E-17
- `frontend/src/screens.jsx` — E-15 (delete ExplainScreen), E-19
- `frontend/src/console.jsx` — E-16
- `frontend/src/console-ext.jsx` — E-18
- `frontend/src/more-screens.jsx` — E-20
- `frontend/src/lib/api.ts` — E-14
- `frontend/src/types.ts` — E-14

**Frontend (new):**

- `frontend/src/lib/session.tsx` — E-14
- `frontend/src/lib/thresholds.ts` — E-14
- `frontend/src/lib/useResultsPolling.ts` — E-14
- `frontend/src/lib/useCalibratedTimeline.ts` — E-14

**Repo docs:**

- `Plan.md` (continuous E-21)

## Coordination notes

- **Blocks Yoav** on E-14 (`useCalibratedTimeline` is shared with Y-14, `lib/session.tsx` is shared with Y-13/Y-15/Y-16).
- **Blocked by Yoav** on Y-12 (recorder) — E-17 / E-20 cannot ship until the recorder hook exists.
- **Blocked by Yoav** on Y-17 — E-20's enroll dialog needs `getAvailability` to flip the ID-Available pill.
- **Standing rule:** every UI PR includes a screenshot; every backend PR includes a curl/pytest snippet. Both engineers review each other's PRs end-to-end.
