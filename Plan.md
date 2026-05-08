# BioVoice — UI Implementation Plan

> **Status legend:** ⬜ pending · 🟡 in progress · ✅ done · ⛔ blocked
> **Last updated:** 2026-05-08
> **Owner of this file:** Eden (UI lead — keeps it updated as phases progress)
> **Source of truth for screens:** `docs/SDD-6 Riva.pdf` §5 (Figures 15–20). **TCAV (Figure 19) is dropped** for this milestone — it is not yet working and is removed from scope until further notice.

---

## 1. Goals

The BioVoice UI must be production-grade for the Israel National Cyber Directorate evaluation and the supporting research paper. The current frontend is a developer dashboard; the SDD mockups specify a polished desktop-style application. We are rebuilding the UI to match the mockups deeply (not pixel-shimming) and wiring it to the existing FastAPI backend.

**Acceptance bar:**

- All 5 in-scope screens (Enrollment, Processing, Deepfake Result, Verification Result, Test Lab) render at parity with the mockups on a 1280×800 desktop window and degrade gracefully down to 1024×768.
- End-to-end flow (enroll → login → verify → see result) works against the real backend with no console errors.
- Latency budget per SDD §1.5: < 2 s from "stop recording" to result.
- Audio constraints per SDD §1.5: 16 kHz mono, 1–10 s recordings.
- Decision logic per SDD §2.5: `ACCEPT = (similarity ≥ 0.75) ∧ (deepfake_score ≥ 0.5)`.

## 2. Team

**Two-person team for this milestone.** Idan is not active; his backend tasks have been redistributed.

| Member | Role | Owns |
|---|---|---|
| **Eden Adiv** | UI lead, architecture, integration | Design system, app shell, Home/Login/Verification Result screens, backend extensions for verification records, view-details endpoint, decision-logic alignment with SDD §2.5, perf probe, plan upkeep |
| **Yoav Zucker** | Frontend audio + active screens | Audio capture rewrite, Waveform component, Enrollment/Processing/Deepfake Result/Test Lab screens, ID-availability endpoint, AASIST sub-score derivation, spoof-test endpoint |

Eden is the UI leader and the final reviewer on visual / UX questions. Yoav is the audio specialist and the final reviewer on anything microphone-adjacent. Both engineers do their own backend work for the screens they own — the engineer who consumes an endpoint also writes it.

## 3. Scope (in / out)

**In scope (this milestone):**

| # | Screen (SDD §) | Mockup | Owner |
|---|---|---|---|
| 1 | Enrollment Screen (5.1) | Fig. 15 | Yoav |
| 2 | Processing Screen (5.2) | Fig. 16 | Yoav |
| 3 | Deepfake Detection Result (5.3) | Fig. 17 | Yoav |
| 4 | Verification Result (5.4) | Fig. 18 | Eden |
| 5 | Deepfake Generator / Test Lab (5.6) | Fig. 20 | Yoav |

**Out of scope (this milestone):**

- TCAV Explanation Screen (SDD §5.5, Fig. 19) — explicitly dropped. Remove all TCAV references from UI copy, plans, and the navigation graph. Do **not** delete the SDD reference; we may revisit later.
- Multi-tenant admin views, profile management UI, audit log viewer.
- i18n / Hebrew RTL — single-language English build for now.

## 4. Architectural decisions

1. **Window chrome.** All screens live inside a single fake-desktop window component (`<AppWindow>`) with macOS-style traffic-light header and a centered title that reflects the current screen. Matches the mockups exactly.
2. **Light theme.** Mockups are light. We replace `styles.css` with a fresh design-token system (CSS custom properties on `:root`). Dark theme is dropped for this milestone.
3. **Single-page, screen-state machine.** No router. `App.tsx` holds a `screen` enum and a `flowState` object (audio buffer, embedding scores, verification id, etc.) that screens read from. Keeps the prestigious-client demo predictable and avoids URL/ref desync.
4. **Backend additions are minimal.** We extend, not rewrite, the existing FastAPI services. New endpoints:
   - `GET /users/{user_id}/availability` — returns `{ available: bool }` for the enrollment ID-Available pill. (**Yoav**)
   - `POST /me/spoof/test` — runs the AASIST detector on an in-flight spoof sample and returns `{ deepfake_score, decision }` so the Test Lab "Test Detection" button can show a result without enrolling/verifying anyone. (**Yoav**)
   - `GET /me/verifications/{result_id}` — returns the full verification record (including stage breakdown the result screen displays). Keeps the Verification Result screen self-contained. (**Eden**)
5. **Processing screen is presentation-layer only.** The pipeline stages (Load Audio → Resample 16 kHz → Normalize → Mel-Spectrogram → Extract Features) are visualized on the client while the single `/me/verify` (or `/me/enroll`) call is in flight. We do not stream stage events from the server in this milestone — the UI advances stages on a calibrated timeline that completes when the response lands. Documented as such in the research paper appendix.
6. **Existing 3-sample enrollment is preserved.** The backend already enforces `min_enrollment_samples = 3` for centroid robustness. The Enrollment screen surfaces "Sample N / 3" alongside the mockup's single-recording layout. The SDD §2.4 figure of "1 sample" is a design simplification; we keep 3 in production and call it out in the paper.
7. **No TCAV anywhere.** Anything referring to "Why This Decision" or TCAV concept bars is removed from `App.tsx`, navigation, and copy.
8. **Engineer-owns-stack.** The engineer who builds a screen also builds the endpoints it consumes. Avoids cross-team handoffs in a two-person team.

## 5. Phased rollout

Each phase is a logical, independently testable chunk. Phase numbers map to assigned tasks in `Eden.md` and `Yoav.md`.

### Phase 0 — Cleanup (drop TCAV, dead code) ⬜

- Audit the codebase for any TCAV-related imports, components, copy, routes; remove them.
- Delete or archive `frontend/src/screens.jsx`, `more-screens.jsx`, `visuals.jsx`, `console.jsx`, `console-ext.jsx`, `audio.jsx`, `app.jsx` if they are not referenced from `main.tsx` (they are leftover prototypes).
- Verify `npm run build` and the FastAPI app still boot.

**Owner:** Eden (frontend audit + backend boot check).

### Phase 1 — Design system foundation ⬜

- New `tokens.css` with light-theme CSS variables matching the mockups (off-white backgrounds, black text, semantic greens/reds/blues/purples for status pills, the orange "test mode" warning band, etc.).
- New `<AppWindow>` shell with traffic-light dots and centered title.
- New shared primitives: `<Button variant="primary|secondary|danger|warn|success">`, `<Badge>`, `<ProgressBar>`, `<Waveform>` (live + static), `<Gauge>` (semicircle for verification score), `<StageList>` (for the processing pipeline).
- Typography stack: Inter for UI, JetBrains Mono for mono labels.

**Owner:** Eden.
**Exit:** demo route (e.g., `?showcase=1`) renders one of each primitive; Yoav signs off via screenshot in the PR before screens consume the primitives.

### Phase 2 — App shell + screen state machine ⬜

- Replace existing `App.tsx` content with a new screen-state machine.
- Screens enum: `home → enroll → processing → deepfake_result → verify_result → test_lab` plus a `login` screen for returning users.
- Shared `flowState`: `{ userId, lastAudio, lastEmbedding?, lastDeepfakeScore?, lastVerification?, sessionToken? }`.
- Persist `sessionToken` in `localStorage` exactly as today.
- Drop the workspace dashboard (it is a developer view — not in mockups). Replace with a minimal `home` landing that routes to "Enroll" or "Login".

**Owner:** Eden.

### Phase 3 — Enrollment screen (Fig. 15) ⬜

- Layout: User ID input (left) + ID-Available pill (right) + "Voice Recording" waveform card + timer + big red record/stop button + tip card.
- Live waveform animation while recording (microphone level → bars).
- Timer counts up `mm:ss.s`. Stops at 10 s with auto-stop; minimum 1 s.
- ID-availability check: debounced 300 ms call to `GET /users/{user_id}/availability`.
- On stop: POST `/enroll` (multipart) → on success advance to Processing screen.
- Show "Sample N / 3" progress indicator (kept from existing 3-sample flow).
- Validation: empty user ID, taken user ID, recording too short, recording too long.

**Owner:** Yoav (screen + availability endpoint).

### Phase 4 — Processing screen (Fig. 16) ⬜

- Stage list: Load Audio → Resample 16 kHz → Normalize → Mel-Spectrogram → Extract Features.
- Each stage shows: pending (gray), in-progress (blue with spinner), done (green check).
- Bottom progress bar with "X% Complete" label.
- Calibrated to advance stages over the duration of the in-flight `/me/verify` (or `/me/enroll`) request; final stage holds until the response lands.
- On success: route to Deepfake Result for verification flow, or directly to Verification Result for the joint flow. The exact next-screen is decided by `flowState.intent` (`enroll` | `verify`).

**Owner:** Yoav.

### Phase 5 — Deepfake Detection Result (Fig. 17) ⬜

- Big verdict card: green "GENUINE AUDIO" or red "SYNTHETIC AUDIO DETECTED" with confidence percentage.
- Analysis Details section with four metrics, each as a horizontal bar:
  - Voice Naturalness
  - Spectral Consistency
  - Temporal Patterns
  - Artifact Detection
- AASIST badge + "Powered by Audio Anti-Spoofing AI" footer.
- Auto-advances after 2 s (or on click) to Verification Result if inside the verification flow.
- The four sub-scores are derived from the existing AASIST score with deterministic per-metric noise (±2 %) so the visualization reads richly without lying about precision; documented in the paper.

**Owner:** Yoav (UI + sub-score derivation in `detector.py`).

### Phase 6 — Verification Result (Fig. 18) ⬜

- Top banner: green "IDENTITY VERIFIED" or red "ACCESS DENIED" + "Welcome back, {name}" / reason.
- Two metric cards side-by-side:
  - Voice Similarity gauge (0.00 – 1.00) with threshold marker at 0.75.
  - Authenticity Check status icon + "Audio is genuine" / "Audio flagged as synthetic".
- Three buttons: Continue (primary green), Try Again (gray), View Details (blue).
- Footer: timestamp + Session ID `VRF-YYYY-MMDD-XXXX`.
- "View Details" opens a modal listing per-sample similarities and the centroid similarity (we already compute these — see `verification.py:130-135`).

**Owner:** Eden (screen + `/me/verifications/{result_id}` endpoint, session ID format, decision-logic alignment).

### Phase 7 — Deepfake Generator / Test Lab (Fig. 20) ⬜

- Orange "TESTING MODE — For validation purposes only" banner.
- Source Audio waveform card with file picker / reference-sample picker.
- External TTS API config card: service name (read-only "Voice Cloning API"), target text textarea.
- Big orange "Generate Fake" button → calls existing `POST /me/spoof`.
- Generated Deepfake waveform card (tinted red).
- "Test Detection" button → calls new `POST /me/spoof/test` endpoint with the generated WAV → shows the AASIST score inline.
- Status footer: "Ready to generate test sample" / "Generated. Test detection?" / "Detection score: 0.04 (FAKE)".

**Owner:** Yoav (UI + `/me/spoof/test` endpoint).

### Phase 8 — Backend support ⬜

Concrete endpoint additions and changes:

| Endpoint | Method | Purpose | Owner |
|---|---|---|---|
| `/users/{user_id}/availability` | GET | ID-Available pill | Yoav |
| `/me/verifications/{result_id}` | GET | View Details modal | Eden |
| `/me/spoof/test` | POST | AASIST score for an arbitrary WAV | Yoav |

Plus:

- `verification.py` already returns `centroid_similarity` and `sample_similarities`. Add `session_id` (formatted) and a `stage_breakdown: {load_ms, resample_ms, mel_ms, embed_ms, detect_ms}` to `VerificationResponse`. Wire timings with `time.perf_counter()` around the existing call sites. **(Eden)**
- `detector.py` extends to expose `analysis_details: { voice_naturalness, spectral_consistency, temporal_patterns, artifact_detection }`. For now derive deterministically from the global AASIST score with seeded jitter; document in the paper. **(Yoav)**
- Decision-logic alignment with SDD §2.5 (preprocess → embedding → AASIST → if DF<0.5 reject as fake → similarity → if sim<0.75 reject as mismatch → accept), with copy-locked messages and a machine-readable `decision_reason` enum. **(Eden)**

### Phase 9 — QA & Validation ⬜

- Manual run-through of the full happy path on macOS (Chrome + Safari) at 1280×800.
- Negative paths: empty mic input, taken user ID, < 1 s recording, > 10 s recording, mid-recording cancel, network error, deepfake-flagged audio.
- Performance: confirm < 2 s end-to-end for verify (SDD §1.5).
- Accessibility smoke: keyboard-only navigation through Enrollment, Verification Result, Test Lab.
- Cross-engineer code review (Eden ↔ Yoav).

**Owners:** Both. Eden coordinates and signs off the visual + integration bar; Yoav signs off the audio + active-screen bar.

## 6. Repository layout after the rebuild

```
frontend/src/
  App.tsx                  # screen state machine
  main.tsx
  styles/
    tokens.css             # design tokens (light)
    base.css               # resets + base typography
    primitives.css         # styles for shared primitives
    screens.css            # per-screen layouts
  components/
    AppWindow.tsx          # macOS-style window chrome
    Button.tsx
    Badge.tsx
    Gauge.tsx
    ProgressBar.tsx
    StageList.tsx
    Waveform.tsx           # live + static
  screens/
    HomeScreen.tsx
    EnrollScreen.tsx
    ProcessingScreen.tsx
    DeepfakeResultScreen.tsx
    VerifyResultScreen.tsx
    TestLabScreen.tsx
    LoginScreen.tsx
  lib/
    api.ts                 # extended with new endpoints
    audio.ts               # mic capture + WAV encoding
    flowState.ts           # screen transitions
  types.ts
backend/app/
  api/routes.py            # + /availability, + /me/verifications, + /me/spoof/test
  services/
    detector.py            # + analysis_details
    verification.py        # + stage_breakdown, + session_id, + decision_reason
```

Components from the old prototype to delete in Phase 0: `screens.jsx`, `more-screens.jsx`, `visuals.jsx`, `console.jsx`, `console-ext.jsx`, `audio.jsx`, `app.jsx`. The current `.tsx` components (`AuthRecordingForm`, `ResultCard`, `SimilarityInsights`, `SpoofStudio`, `VerificationHistory`, `RecordPanel`, `Panel`, `StatusPill`) are superseded by the screens above — keep them in git history; remove them from the build once their screens are live.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Mockup waveforms have ~50 bars at full width — naive ScriptProcessor smoothing produces ugly aliasing. | Use `requestAnimationFrame` + analyser FFT 512, downsample by averaging fixed-width buckets. Yoav owns. |
| AASIST sub-scores are not real per-metric outputs. | Deterministic seeded derivation, transparently documented in the research paper appendix. Yoav owns the derivation function and the documentation paragraph. |
| Single-shot 3-sample enrollment doesn't match Fig. 15's single-record UI. | Show a "Sample N / 3" indicator + progress dots. After sample 3, route to Login. UX is honest. |
| < 2 s latency budget on cold ReDimNet load. | Warm the model on backend startup (already done in `services/speaker_encoder.py` if `lazy=False`). Verify in Phase 9 (Eden). |
| The Processing screen advances stages on a timeline, not real backend events — looks fake under network slowness. | Cap stage 1–4 at 60 % of the wall clock; stage 5 (Extract Features) holds until the response. If the response takes > 4 s, switch to an indeterminate "Still working…" indicator. |
| Two-person team means single-reviewer PRs. | Both engineers must read each other's PRs end-to-end. UI PRs require a screenshot in the description; backend PRs require a curl/pytest snippet. |

## 8. Communication

- Daily 5-minute stand-up message in Slack/WhatsApp covering: shipped, in flight, blockers.
- Weekly sync: 30 min, Wednesday 18:00 IDT.
- Status updates land in this `Plan.md` checkbox grid (mark phase status as you go).
- PRs target `main` via topic branches, one per phase. The other engineer is the required reviewer.

## 9. Open questions

- [ ] Should "Continue" on the Verification Result navigate to the home screen or to a (future) post-auth dashboard? Default for this milestone: home screen.
- [ ] Final session ID format. Proposing `VRF-YYYY-MMDD-XXXX` where `XXXX` is the last 4 chars of `result_id`.
- [ ] Will Idan rejoin during the QA phase? If yes, he picks up the perf probe and an extra QA pass.
