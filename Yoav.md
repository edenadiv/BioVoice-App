# Yoav — Tasks

> Owner: Yoav Zucker. Cross-references `Plan.md` (master plan).
> **Role on this milestone:** Frontend audio + the four "active" screens — Enrollment, Processing, Deepfake Result, Test Lab. Yoav owns everything microphone-adjacent on the client. With Idan out, Yoav also owns the deepfake-side and availability backend work.

> **Status legend:** ⬜ pending · 🟡 in progress · ✅ done · ⛔ blocked

> **Note:** Idan is not active this milestone. Yoav picks up his ID-availability endpoint, AASIST sub-score derivation, and spoof-test endpoint — all of them feed the screens Yoav already owns. Eden takes the verification-side backend work.

---

## Sprint 1 — Audio plumbing

### Y-1. Audio capture rewrite ⬜

Current `components/AudioRecorder.tsx` uses `ScriptProcessorNode` (deprecated) with hard-coded 20 bars and crude smoothing. Rewrite as `lib/audio.ts` + `components/Waveform.tsx`:

- Use `AudioContext` + `AnalyserNode` (no ScriptProcessor for capture; use `AudioWorkletNode` if it lands cleanly, otherwise keep capture via `MediaRecorder` + WebAudio for visualization).
- Capture into a `Float32Array` buffer at the device sample rate, then resample to 16 kHz on stop using `OfflineAudioContext`.
- Encode WAV via the existing `lib/wav.ts` (16-bit PCM, mono, 16 kHz).
- Emit:
  - Live `level: number` (0..1) every animation frame for the bar visualizer.
  - On stop: `{ wavFile: File, durationSec: number, sampleRate: 16000 }`.
- Min recording: 1 s. Max: 10 s (auto-stop). Fire `onWarn` at 8 s.

**Definition of done:** a 5-second recording produces a 16 kHz mono WAV that the backend `services/audio.py:decode_wav` accepts without error, and the bars in `Waveform.tsx` look like the mockup at all volume levels (no clipping, no flat-line dead zones).

### Y-2. Waveform component ⬜ (jointly with Eden's E-2)

`components/Waveform.tsx` supports two modes:

```tsx
<Waveform mode="live"   analyser={analyserNode} bars={48} color="blue" />
<Waveform mode="static" samples={float32}      bars={48} color="red"  />
```

- Static mode: average absolute samples into 48 buckets, normalize, render rounded vertical bars.
- Live mode: `getByteFrequencyData` averaged into 48 buckets, RAF-driven, smoothed with EMA (`α = 0.7`).
- Color variants: `blue` (default), `red` (Test Lab generated), `gray` (idle).

**Definition of done:** both modes render at 60 fps on a M1 MacBook Air; the static mode is a deterministic function of input samples.

---

## Sprint 2 — Screens

### Y-3. Enrollment screen (Phase 3, Fig. 15) ⬜

- Page header: title "New User Enrollment", subtitle "Record your voice to create a unique voiceprint".
- Form row: `User ID` text input on the left (`john_doe_123`), `<Badge>` on the right showing `🔵 Checking...` → `✅ ID Available` / `❌ ID Taken` (debounced 300 ms call to `GET /users/{user_id}/availability`, owned by Y-7).
- Body: "Voice Recording" label + `<Waveform mode="live">` filling the recording card.
- Below waveform: timer in mono (`mm:ss.s`), centered.
- Big circular record button (red filled square when recording, blue mic icon when idle). State label "Recording…" / "Tap to record".
- Tip card at bottom: "💡 Tip: Speak naturally for 3–10 seconds. Say anything you like! A quiet environment will give best results."
- Sample-progress strip (bottom): `● ● ○` for 1/3, 2/3, 3/3 — keeps the current 3-sample backend behavior visible.
- On stop: validate (1–10 s), then `POST /enroll` (multipart `user_id` + `audio`).
- On success: dispatch `flowState.intent = 'enroll'` and route to Processing.
- On 3rd successful sample: route to Login screen with the `userId` pre-filled and a banner "Enrollment complete. Sign in with your voice."

**Definition of done:** matches Fig. 15. ID-Available pill flips correctly. Negative cases (recording too short, ID taken, network down) show a non-modal inline error.

### Y-4. Processing screen (Phase 4, Fig. 16) ⬜

- Layout matches Fig. 16: title "Processing Audio", subtitle "Converting your voice to a secure voiceprint".
- `<StageList>` with these stages:
  1. Load Audio
  2. Resample 16 kHz
  3. Normalize
  4. Mel-Spectrogram
  5. Extract Features
- `<ProgressBar>` at the bottom with "X% Complete" label.
- Behavior:
  - On screen mount, the previous screen's submit promise is already in flight (passed via `flowState.pendingPromise`).
  - Drive stages on a calibrated timeline: each stage takes ~`expected_total / 5`, where `expected_total` defaults to `1.2 s`. Stage 5 holds (in `active` state) until the promise settles.
  - If the promise takes > 4 s, switch the bottom label to "Still working…" and slow the bar to a crawl.
- On promise resolution:
  - Verify intent → Deepfake Result screen with the response payload.
  - Enroll intent → return to Enroll screen with sample counter incremented; or Login screen if 3/3.
- On promise rejection: show the error inline and offer "Back" / "Retry".

**Definition of done:** at 1.2 s wall clock the full progress bar fills smoothly; at 5 s the screen still feels alive; errors don't strand the user.

### Y-5. Deepfake Detection Result screen (Phase 5, Fig. 17) ⬜

- Verdict card at top:
  - Genuine: light-green bg, green check icon, "GENUINE AUDIO", "This audio appears to be from a real human speaker.", "No signs of synthetic generation or manipulation detected.", "Confidence: {score*100}%".
  - Synthetic: light-red bg, red shield icon, "SYNTHETIC AUDIO DETECTED", "This audio shows signs of AI generation or manipulation.", "Confidence: {(1-score)*100}%".
- Analysis Details list, four rows of `<ProgressBar>` with right-aligned percentage labels:
  - Voice Naturalness — `analysis_details.voice_naturalness`
  - Spectral Consistency — `analysis_details.spectral_consistency`
  - Temporal Patterns — `analysis_details.temporal_patterns`
  - Artifact Detection — `analysis_details.artifact_detection` (low is good for genuine audio; render this bar in green when low)
- AASIST badge at bottom-left, "Powered by Audio Anti-Spoofing AI" caption.
- Auto-advance after 2.4 s to Verification Result if `flowState.intent = 'verify'`. If user clicks anywhere, advance immediately.

**Definition of done:** numbers match `analysis_details` in the response (no client-side fudging). Auto-advance can be paused by hovering the verdict card.

### Y-6. Test Lab screen (Phase 7, Fig. 20) ⬜

This is the public testing/validation surface.

- Top warning banner (orange): "⚠️ TESTING MODE — For validation purposes only".
- "Deepfake Audio Generator" headline + "Generate synthetic audio to test detection capabilities".
- Two cards side-by-side:
  - **Source Audio** (left): waveform card + filename caption + an upload button. Optionally a dropdown of saved reference samples (`GET /me/reference-samples`).
  - **External TTS API** (right, blue-tinted): "Service: Voice Cloning API" (read-only), "Target text:" textarea (default "Hello, this is a test message").
- Big orange "Generate Fake" button between the cards (or below). Calls `POST /me/spoof` with the source + text.
- After generation:
  - Below the cards: "Generated Deepfake" headline + a red-tinted waveform card showing the generated WAV.
  - Right side: red "Test Detection" button → `POST /me/spoof/test` (built in Y-9) → updates the status footer.
- Status footer line: "Status: Ready to generate test sample" / "Status: Generated. Click Test Detection." / "Status: Detection score 0.04 — flagged as FAKE ✅".

**Definition of done:** matches Fig. 20. Uses the shared `<Waveform mode="static">`. Generated WAV plays back via an `<audio>` element on click. Deletes its blob URL on screen unmount.

---

## Sprint 3 — Backend extensions Yoav owns

These tasks were Idan's; they now belong to Yoav because they feed the screens Yoav already owns.

### Y-7. ID-availability endpoint ⬜

```http
GET /users/{user_id}/availability  →  { "available": true|false }
```

- No auth.
- 200 with `{ available: bool }`. Validate `user_id` against `^[a-zA-Z0-9_\-\.]{3,32}$`. Return 422 on bad shape.
- Backed by `VerificationStore.get_speaker(user_id) is None`.

**Definition of done:** the Enroll screen (Y-3) calls it from the ID-Available pill and gets a stable `available` boolean. Add a lightweight pytest under `backend/tests/test_users.py`.

### Y-8. Deepfake analysis details ⬜

`detector.py` currently returns a single AASIST score. The Deepfake Result screen (Fig. 17) shows four sub-metrics. We will derive them deterministically.

```python
def analysis_details_from_score(score: float, *, seed_audio_hash: str) -> AnalysisDetails:
    """
    Deterministic derivation of UI-facing sub-scores from the global AASIST score.
    Each sub-metric is anchored to `score` with seeded jitter (±0.02) so the bars
    look richly resolved without lying about precision. The derivation is
    documented in the research paper appendix (see Plan.md §7 risks table).
    """
```

- Sub-metrics: `voice_naturalness`, `spectral_consistency`, `temporal_patterns`, `artifact_detection`. The first three should track `score`; `artifact_detection` should track `1 - score` (high = many artifacts found = synthetic).
- Seed must be `seed_audio_hash` (stable per-audio) so re-asking returns the same result.
- Bound each in `[0.0, 1.0]`.
- Wire `analysis_details` into `VerificationResponse` (coordinated with Eden's E-7).
- Unit test: 100 random scores produce sub-scores within ±0.02 of expectation.

**Definition of done:** every `VerificationResponse.analysis_details` is populated; values are stable across repeated calls on the same audio. Document the derivation in `Plan.md` §7 risks table and in a code comment above the function.

### Y-9. Spoof-test endpoint ⬜

```http
POST /me/spoof/test
  multipart audio: WAV
  →  { "deepfake_score": 0.04, "decision": "FAKE" | "GENUINE", "analysis_details": {...} }
```

- Auth required.
- Reuses `DeepfakeDetectorService.detect()` and `analysis_details_from_score()`.
- `decision = "FAKE"` if `deepfake_score < 0.5`, else `"GENUINE"`.
- Latency must stay under 200 ms (we're not running full verification).

**Definition of done:** the Test Lab "Test Detection" button (Y-6) posts the freshly generated spoof WAV and renders the result in the status footer. Include a pytest in `backend/tests/test_spoof.py`.

---

## Sprint 4 — Polish

### Y-10. Microphone permission UX ⬜

- Detect denial of mic permission and route to a small "Microphone access required" screen with a Retry button.
- Confirm Safari and Chrome both produce the WAV the backend accepts.

### Y-11. Recording-failure recovery ⬜

- If the WAV blob is < 1 s or empty, surface "Recording too short, try again" without dropping the user out of the Enroll screen.

---

## Files Yoav owns

**Frontend:**

- `frontend/src/lib/audio.ts`
- `frontend/src/components/Waveform.tsx` (jointly with Eden)
- `frontend/src/screens/EnrollScreen.tsx`
- `frontend/src/screens/ProcessingScreen.tsx`
- `frontend/src/screens/DeepfakeResultScreen.tsx`
- `frontend/src/screens/TestLabScreen.tsx`

**Backend (taken from Idan's old scope):**

- `backend/app/api/routes.py` (additions: `/users/{user_id}/availability`, `/me/spoof/test`)
- `backend/app/services/detector.py` (analysis details, hashing)
- `backend/app/services/spoof.py` (existing — extend if needed for `/me/spoof/test` integration)
- `backend/app/schemas.py` (additions: `AnalysisDetails`)
- `backend/tests/test_users.py` (new)
- `backend/tests/test_spoof.py` (new)

## Coordination notes

- **Blocked by Eden's E-2** (design primitives) before screens can be styled.
- **Blocked by Eden's E-9** for the shared `decision_reason` enum (the Deepfake Result screen needs it to know whether to auto-advance to Verification Result or stop on a synthetic-audio denial).
- Audio capture rewrite (Y-1) is independent and should ship first — it unblocks every screen with a microphone.
- Any change to the WAV encoding or sample rate must be communicated to Eden (he validates server-side via the verification flow).
- Eden is the UI lead — defer to him on visual / UX disputes.
