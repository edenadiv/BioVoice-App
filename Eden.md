# Eden — Tasks

> Owner: Eden Adiv. Cross-references `Plan.md` (master plan).
> **Role on this milestone:** **UI lead**. Owns the design system, app shell, the marquee Verification Result screen, the Home/Login flow, and the backend extensions that feed the result screen (verification record fields, view-details endpoint, decision-logic alignment, perf probe). Also owns `Plan.md` upkeep.

> **Status legend:** ⬜ pending · 🟡 in progress · ✅ done · ⛔ blocked

> **Note:** Idan is not active this milestone. His backend tasks were redistributed — Eden owns the verification-side backend work, Yoav owns the deepfake-side and availability work.

---

## Sprint 1 — Foundation

### E-1. Phase 0 audit (frontend + backend boot) ⬜

- Confirm the legacy `.jsx` files (`screens.jsx`, `more-screens.jsx`, `visuals.jsx`, `console.jsx`, `console-ext.jsx`, `audio.jsx`, `app.jsx`) are not referenced from `main.tsx`. If clean, delete them.
- Grep the frontend for any `tcav|TCAV|concept|"Why This Decision"` and remove. Grep the backend for the same — there should be nothing today, but confirm.
- Sanity-check that the FastAPI app boots (`uvicorn app.main:app --reload` from `backend/`). Document any startup warnings.
- Confirm `services/speaker_encoder.py` warm-loads ReDimNet on boot so the first verify request stays under the 2 s budget.
- Run `npm run build` and confirm green.

**Definition of done:** clean `tsc -b && vite build`, clean `uvicorn` boot, no TCAV strings remain anywhere, repo diff is one focused commit.

### E-2. Design system — tokens & primitives (Phase 1) ⬜

- Replace `frontend/src/styles.css` with `styles/tokens.css` + `styles/base.css` + `styles/primitives.css`.
- Implement light-theme tokens from the mockups:
  - `--bg-window: #ffffff`, `--bg-titlebar: #2f2f33`, `--bg-surface: #f4f5f7`, `--bg-info: #eaf2ff`, `--bg-success: #e8f6ec`, `--bg-warn: #fff1e0`, `--bg-test: #fbe9d6`.
  - Text: `--text-primary: #1c1d20`, `--text-secondary: #6b7180`.
  - Accent: `--accent-success: #2ecc71`, `--accent-danger: #e74c3c`, `--accent-warn: #f08a2a`, `--accent-info: #3686ff`, `--accent-neutral: #8a8f9a`.
  - Radii: `--r-sm: 6px`, `--r-md: 10px`, `--r-lg: 18px`.
  - Shadow: `--shadow-window: 0 24px 60px rgba(20, 26, 36, 0.18)`.
- Build primitives in `components/`:
  - `AppWindow.tsx` — macOS chrome (red/yellow/green dots, centered title), 800×600 minimum, scales to viewport.
  - `Button.tsx` — variants `primary` (blue), `success` (green), `warn` (orange), `danger` (red), `secondary` (gray), `ghost`.
  - `Badge.tsx` — pill with optional left icon (used by ID-Available pill, GENUINE AUDIO chip).
  - `ProgressBar.tsx` — horizontal, animated, supports `value` 0–100.
  - `Gauge.tsx` — semicircle gauge (0.00–1.00), with threshold marker.
  - `StageList.tsx` — vertical list of stages with status (`pending|active|done`), connector line.
  - `Waveform.tsx` — accepts either a live `AnalyserNode` (live mode) or a `Float32Array` (static mode); renders 48 bars; spec'd with Yoav so live + replay use the same visual.
- Add a `?showcase=1` query route in `App.tsx` that renders one of each primitive for review. Keep until end of Phase 2.

**Definition of done:** primitives render under `?showcase=1`; Yoav signs off via screenshot in the PR.

### E-3. App shell + screen state machine (Phase 2) ⬜

- Rewrite `App.tsx` as a screen state machine. Screens enum: `home | login | enroll | processing | deepfake_result | verify_result | test_lab`.
- Centralize `flowState`:
  ```ts
  type FlowState = {
    intent: "enroll" | "verify";
    userId: string;
    sampleIndex?: number;       // 1..3 during enrollment
    audioFile?: File;
    sessionToken?: string;
    lastDeepfakeScore?: number;
    lastDeepfakeDetails?: AnalysisDetails;
    lastVerification?: VerificationResult;
  };
  ```
- Hydrate `sessionToken` from `localStorage` on mount. Drop the existing workspace dashboard from the visible flow (keep it on a dev-only `?dev=1` route for backend smoke testing — for **internal use only**).
- All screens receive `flowState` and a `dispatch({ type, payload })` reducer. Keep this in `lib/flowState.ts`.

**Definition of done:** Home → Enroll happy path navigates to Processing then to Deepfake Result then to Verify Result with stub data, in light mode, inside the AppWindow. No real network calls yet — those are wired by the screen owners.

---

## Sprint 2 — Screens I own

### E-4. Home + Login screens (Phase 2 follow-up) ⬜

- Home screen: brand mark + tagline, two big buttons "New User Enrollment" and "Voice Login".
- Login screen: User ID input, single record button, "Authenticate" CTA. On success, advance via Processing → Verify Result. Reuse the recorder built by Yoav.

**Definition of done:** the two screens match the visual rhythm of the other mockup screens (single window, centered content, soft shadows). Login wiring uses `POST /auth/login`.

### E-5. Verification Result screen (Phase 6) ⬜

This is the marquee screen for the demo. Match Fig. 18 exactly.

- Top banner card:
  - Success: light-green background, green check circle, headline "IDENTITY VERIFIED", body "Welcome back, {name}!", subtle "Voice match confirmed".
  - Reject: light-red background, red X circle, headline "ACCESS DENIED", body explains reason ("Speaker did not match enrolled profile" / "Audio flagged as synthetic").
- Two metric cards in a row:
  - Voice Similarity: `<Gauge>` rendering `result.similarityScore` against threshold 0.75; label `<score>` + "score" + "Threshold: 0.75".
  - Authenticity Check: green check + "Audio is genuine" if `deepfakeScore >= 0.5`; red X + "Audio flagged as synthetic" otherwise.
- Action row: Continue (success), Try Again (secondary), View Details (info).
- Footer text rows: `Verified at {timestamp}` and `Session ID: VRF-YYYY-MMDD-XXXX` (last 4 of `result_id`).
- "View Details" → modal listing `centroidSimilarity` + each `sampleSimilarities[i]` + `stage_breakdown` from the response.
- Continue → routes to home and clears `flowState`.
- Try Again → routes back to Login (or Enroll if intent was enroll).

**Definition of done:** screen pixel-snaps to Fig. 18 within ~4 px tolerance, View Details modal renders the breakdown returned by E-7's extended `/me/verify` response.

### E-6. Plan.md upkeep ⬜ (continuous)

- Maintain `Plan.md` as the source of truth: tick off phases, log decisions, log open questions.
- Commit message convention: `docs(plan): ...`.

---

## Sprint 3 — Backend extensions I own

These tasks were Idan's; they now belong to Eden because they feed the Verification Result screen Eden owns.

### E-7. Verification record extensions (Phase 8) ⬜

Extend `VerificationResponse` (and `VerifyResult` model) with:

```python
class VerificationResponse(BaseModel):
    # ... existing fields ...
    session_id: str               # "VRF-2026-0508-AB12" formatted
    stage_breakdown: StageBreakdown
    decision_reason: Literal["accepted", "mismatch", "synthetic", "not_enrolled"]
```

```python
class StageBreakdown(BaseModel):
    load_ms: float
    resample_ms: float
    normalize_ms: float
    mel_ms: float
    embed_ms: float
    detect_ms: float
    total_ms: float
```

- Wire timings in `services/verification.py:verify()` using `time.perf_counter()`.
- `session_id` format: `VRF-{YYYY}-{MMDD}-{XXXX}` where `XXXX = result_id[-4:].upper()`.
- Persist `stage_breakdown` and `decision_reason` on `VerificationRecord.metadata` so historical queries return them.

**Definition of done:** existing `/verify` and `/me/verify` responses include the new fields without breaking the frontend's existing typed parsers.

### E-8. View-details endpoint (Phase 8) ⬜

```http
GET /me/verifications/{result_id}  →  VerificationResponse
```

- Auth required. 404 if `result_id` doesn't belong to the authenticated `user_id`.
- Returns the full record built by E-7.

**Definition of done:** Eden's "View Details" modal (E-5) wires to this endpoint and renders centroid, per-sample similarities, and stage breakdown.

### E-9. Decision logic alignment with SDD §2.5 ⬜

Current `services/verification.py` returns `DEEPFAKE` if the deepfake score is below threshold. The SDD specifies:

```
ACCEPT = (similarity ≥ 0.75) ∧ (deepfake_score ≥ 0.5)
```

- Confirm the order of checks matches the SDD activity diagram (Fig. 13): preprocess → embedding → AASIST → if DF<0.5 reject as fake → similarity → if sim<0.75 reject as mismatch → accept.
- Tighten the messages so they match the UI copy:
  - DEEPFAKE → "Audio flagged as synthetic. Access denied."
  - REJECT → "Speaker did not match the enrolled profile."
  - ACCEPT → "Identity verified."
- Surface a `decision_reason` enum (`accepted | mismatch | synthetic | not_enrolled`) on the response.

**Definition of done:** all three decisions have stable, copy-locked messages and machine-readable reasons. Yoav's Deepfake Result screen consumes the same enum.

### E-10. Verification tests ⬜

- `tests/test_verification.py` — happy path (ACCEPT), mismatch (REJECT), deepfake-flagged (DEEPFAKE).
- Use FastAPI's `TestClient` with the in-memory store fixture.

**Definition of done:** `pytest backend/tests/test_verification.py` is green.

### E-11. Performance probe ⬜

- Add a one-shot script `backend/scripts/bench_verify.py` that posts 10 verifications against the running server and prints p50/p95 timings + the new `stage_breakdown`.
- Confirm p95 < 2 s on a dev box. Append numbers to `Plan.md` §7 risks table.

---

## Sprint 4 — QA pass

### E-12. Cross-screen polish ⬜

- Audit all 5 screens at 1280×800 and 1024×768. File issues for misalignments, missing focus states, contrast issues.
- Confirm keyboard-only navigation: Tab order through Enrollment, Verification Result, Test Lab.
- Verify `<2s` p50 verify latency by manual stopwatch over 10 runs.

### E-13. Demo script ⬜

- Prepare a 90-second walkthrough script for the client. Topics: enrollment, processing visualization, genuine vs synthetic, verification gauge.

---

## Files Eden owns

**Frontend:**

- `Plan.md`
- `frontend/src/App.tsx`
- `frontend/src/main.tsx`
- `frontend/src/styles/tokens.css`
- `frontend/src/styles/base.css`
- `frontend/src/styles/primitives.css`
- `frontend/src/components/AppWindow.tsx`
- `frontend/src/components/Button.tsx`
- `frontend/src/components/Badge.tsx`
- `frontend/src/components/Gauge.tsx`
- `frontend/src/components/ProgressBar.tsx`
- `frontend/src/components/StageList.tsx`
- `frontend/src/components/Waveform.tsx` (jointly with Yoav)
- `frontend/src/screens/HomeScreen.tsx`
- `frontend/src/screens/LoginScreen.tsx`
- `frontend/src/screens/VerifyResultScreen.tsx`
- `frontend/src/lib/flowState.ts`

**Backend (taken from Idan's old scope):**

- `backend/app/api/routes.py` (additions: `/me/verifications/{result_id}`)
- `backend/app/schemas.py` (additions: `StageBreakdown`, extended `VerificationResponse`, `decision_reason`)
- `backend/app/services/verification.py` (timings, session id, decision messages, decision_reason)
- `backend/tests/test_verification.py` (new)
- `backend/scripts/bench_verify.py` (new)

## Coordination notes

- **Blocks Yoav** on E-2 (primitives must exist before he wires Enroll/Processing/Test Lab screens).
- **Blocks Yoav** indirectly on E-9 — the `decision_reason` enum is shared between Verification Result and Deepfake Result screens.
- **Needs from Yoav** before final QA: the audio capture rewrite (Y-1) and the AASIST analysis details (Y-5).
- Daily 5-min stand-up message covering: what shipped yesterday, what's in flight, blockers.
- API contract changes go through a 24 h notice; Yoav updates his typed parser in lockstep.
