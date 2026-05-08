# Yoav — Tasks

> Owner: Yoav Zucker. Cross-references `Plan.md` (master plan).
> **Role on this milestone:** audio + active screens + the two pending backend routes. Yoav owns everything microphone-adjacent on the client and ships the AASIST sub-score derivation that feeds the Deepfake screens.

> **Status legend:** ⬜ pending · 🟡 in progress · ✅ done · ⛔ blocked

---

## Superseded earlier tasks

The previous Y-1…Y-11 task list targeted the macOS-window rebuild from the SDD §5 figures. That rebuild was a misread (see `MIGRATION_POSTMORTEM.md`). Those tasks are **superseded** by this milestone:

- Y-1 (audio capture rewrite) → continues as **Y-12** below, but against the kiosk prototype, not the SDD screen rewrite.
- Y-2 (Waveform component) → not needed; the prototype's `<Waveform>` in `visuals.jsx` is the design. No rewrite.
- Y-3 (Enroll screen rewrite) → continues as **Y-13** (wire the existing kiosk EnrollScreen, don't rebuild it).
- Y-4 (Processing screen rewrite) → continues as **Y-14**.
- Y-5 (Deepfake Result screen rewrite) → continues as **Y-15**.
- Y-6 (Test Lab screen rewrite) → continues as **Y-16** against the existing DeepfakeLab.
- Y-7, Y-8, Y-9 (backend availability / sub-scores / spoof-test) → continue as **Y-17, Y-19, Y-18**.
- Y-10, Y-11 (mic permission + recovery UX) → continues as **Y-20**.

---

## This milestone (Wire-Live)

### Sprint A — Foundation (day 1)

#### Y-12 — Recorder hook (`lib/audio.ts`) ⬜ — **KEYSTONE**

This blocks every screen that POSTs to the backend. Ship first.

```ts
// lib/audio.ts
export type RecorderState = "idle" | "requesting" | "recording" | "stopped" | "denied" | "error";

export type RecorderOptions = {
  minMs?: number;     // default 1000
  maxMs?: number;     // default 10_000
  warnAtMs?: number;  // default 8000
};

export type RecordingResult = {
  wavFile: File;
  durationSec: number;
  sampleRate: 16000;
};

export function useVoiceRecorder(options?: RecorderOptions): {
  state: RecorderState;
  level: number;                                  // 0..1, RAF-driven
  durationMs: number;
  start(): Promise<void>;                         // requests getUserMedia, opens a real MediaStream
  stop(): Promise<RecordingResult | null>;        // null if min duration unmet
  cancel(): void;
};
```

Implementation notes:
- Capture path: `navigator.mediaDevices.getUserMedia({ audio: true })` → `MediaStreamAudioSourceNode` → `AnalyserNode` (for `level`) **and** an `AudioWorklet` (or fallback `ScriptProcessor`) collecting `Float32Array` chunks.
- On `stop()`: concatenate chunks → `OfflineAudioContext` resampled to 16 kHz → `lib/wav.ts:encodeWav(Float32Array, 16000)` → wrap as `File`.
- **Refuse to start without a real `MediaStream`.** Synthetic audio never reaches this code path.
- Auto-stop at `maxMs` (default 10 000). Reject with `null` if `< minMs` (default 1 000). Fire an `onWarn` event at `warnAtMs` (default 8 000).
- Cleanup in `useEffect` return: stop tracks, close audio context, cancel RAF.

**Definition of done:** a 5-second recording produces a 16 kHz mono WAV that `backend/app/services/audio.py:decode_wav_with_timings` accepts; the level visualizer matches mockup density at all volumes.

#### Y-17 — `GET /users/{user_id}/availability` ⬜

```http
GET /users/{user_id}/availability  →  { "available": true | false }
```

- File: `backend/app/api/routes.py`.
- No auth.
- Validate `user_id` against `^[a-zA-Z0-9_\-\.]{3,32}$`. Return 422 on bad shape.
- Backed by `VerificationStore.get_speaker(user_id) is None`.
- New pytest at `backend/tests/test_users.py` with FastAPI `TestClient`:
  - 200 + `{ available: true }` for unknown id.
  - 200 + `{ available: false }` for an enrolled id.
  - 422 for bad shape.

**Definition of done:** `pytest backend/tests/test_users.py` green; Eden's E-20 enroll dialog can flip its ID-Available pill against this route.

#### Y-19 — `analysis_details_from_score()` ⬜

- File: `backend/app/services/detector.py`.
- Add module-level function:
  ```python
  def analysis_details_from_score(score: float, *, audio_hash: str) -> AnalysisDetails:
      """
      Deterministic AASIST sub-score derivation. Each sub-metric is anchored to
      `score` with seeded jitter (±0.02) so the bars look richly resolved without
      lying about precision. Documented in the research paper appendix
      (Plan.md §8 risks table).
      """
  ```
- Sub-metrics:
  - `voice_naturalness, spectral_consistency, temporal_patterns ≈ score ± 0.02`
  - `artifact_detection ≈ (1 − score) ± 0.02`
  - All clamped to `[0.0, 1.0]`.
- Seed RNG with `hashlib.sha256(audio_hash.encode()).digest()[:4]` for stability per audio.
- File: `backend/app/services/verification.py` — replace `_derive_analysis_details(deepfake_score)` (around line 240–260) with a call to `analysis_details_from_score(deepfake_score, audio_hash=...)`. Compute `audio_hash` as `hashlib.sha256(audio_bytes).hexdigest()` upstream in `verify()`.
- Unit test in `backend/tests/test_verification.py`: 100 random `(score, hash)` pairs, all sub-scores stable across two calls.

**Definition of done:** every `VerificationResponse.analysis_details` returns four distinct numbers (not all equal to the global score); values are stable across repeated calls on the same audio.

### Sprint B — Verification flow (day 2)

#### Y-13 — Wire EnrollScreen ⬜

- File: `screens.jsx:177-308`. Drop the 4.5 s phase timer at lines 188–193 and the `phase === 'done'` shortcut.
- Real flow:
  1. Username input + `<Badge>` next to it. Debounced 300 ms call to `getAvailability(userId)` flips between `Checking…` / `ID Available` / `ID Taken`.
  2. Big record button → Y-12 `useVoiceRecorder.start()`.
  3. On stop → `enrollSpeaker(userId, file)` (or `enrollAuthenticatedSpeaker` if a session exists).
  4. Show `Sample N / 3` progress strip; refetch `listSpeakers()` after each save.
  5. After sample 3 → `onComplete(userId)` (callback unchanged).
- Validation: empty user ID, ID taken, recording too short, recording too long. Inline error under the input — no modal.

**Definition of done:** matches the existing kiosk visual; ID-Available pill works against Y-17; backend stores 3 real samples; refreshing the page persists them.

#### Y-14 — Wire ProcessingScreen ⬜

- File: `screens.jsx:313-421`.
- Drop the hardcoded `[600, 700, 900, 1100, 800, 700]` ms timeline at line 329 and the `seedRand(1337)` synthetic embedding at lines 341–344.
- Use `useCalibratedTimeline(state.flow.pendingPromise, { stages: 6, expectedTotalMs: 1200, slowAfterMs: 4000 })` (hook from E-14).
- The embedding visualization (right column) can sample real-time `audio.freqs` for 192 magnitudes — visual only; backend never returns the embedding vector itself.
- Final stage holds active until the promise resolves.
- > 4 s: bottom subtitle flips to "Still working…", bar holds at 90 %.
- On reject: error inline + Back / Retry buttons; clear the pending promise.

**Definition of done:** at 1.2 s the bar fills smoothly; at 5 s the screen still feels alive; errors don't strand the user.

#### Y-18 — `POST /me/spoof/test` ⬜

```http
POST /me/spoof/test
  Authorization: Bearer {sessionToken}
  multipart audio: WAV
  →  { "deepfake_score": 0.04, "decision": "FAKE" | "GENUINE", "analysis_details": { ... } }
```

- File: `backend/app/api/routes.py`.
- Auth required.
- Reuse `DeepfakeDetectorService.detect()` and `analysis_details_from_score()` (Y-19).
- `decision = "FAKE"` if `deepfake_score < 0.5`, else `"GENUINE"`.
- Latency budget: < 200 ms (no full verify pipeline).
- New pytest at `backend/tests/test_spoof.py`:
  - 200 + `decision: "GENUINE"` for clean audio (use the test conftest's `make_wav`).
  - 200 + `decision: "FAKE"` if you can stub the detector to return `< 0.5`.
  - 401 on missing/invalid token.

**Definition of done:** Y-16's "Test Detection" button posts the freshly generated spoof WAV and renders the verdict in the lab; pytest green.

### Sprint C — Result + Lab screens (day 3)

#### Y-15 — Wire DeepfakeScreen ⬜

- File: `screens.jsx:557-687`.
- Drop the two-phase 1.8 s timer at lines 559–562.
- Read directly from `state.lastVerification`:
  - Verdict banner: `result.decision === 'DEEPFAKE'` → red SYNTHETIC; else → green GENUINE. Confidence: `result.deepfakeScore` (or `1 − deepfakeScore` for synthetic).
  - Four artifact rows at lines 608–611 map 1:1 to `analysisDetails.{voiceNaturalness, spectralConsistency, temporalPatterns, artifactDetection}`.
- Auto-advance to `VerifyScreen` after 2.4 s if `state.flow.intent === 'verify'`. Pause on hover.
- On click anywhere, advance immediately.

**Definition of done:** numbers match `analysisDetails` from the response; auto-advance can be paused; same screen handles both genuine + synthetic outcomes.

#### Y-16 — Wire DeepfakeLab ⬜

- File: `more-screens.jsx:65-305`.
- Drop the four-stage state machine at lines 79–113 and the random `dfScore` / `confidence` / `artifacts` at lines 96–107.
- Real flow:
  1. **Source picker** (replacing the `targetProfile` selector at lines 140–162):
     - Dropdown of `listReferenceSamples(sessionToken)` — show `originalFilename` + `createdAt`.
     - Plus an "Upload WAV" file input. Mutually exclusive.
  2. **Generate** button → `generateSpoofSample(sessionToken, { text, language: 'en', referenceSampleId | file })` (existing wrapper). Disabled until source + non-empty text.
     - On 503: inline yellow banner "Voice cloning model is offline. Try again or pick a saved sample."
     - On success: store the returned blob URL in component state for `<audio src={audioUrl}>` playback.
  3. **Decode the generated blob** for visualization: `AudioContext.decodeAudioData(arrayBuffer)` → `Float32Array` → average into 92 buckets → render via existing `<Waveform>` component.
  4. **Test Detection** button (appears only after generation): refetch the blob, wrap as `File`, call `spoofTest(sessionToken, file)` (E-14 wrapper). Update the verdict card with `deepfake_score`, `decision`, `analysis_details`.
  5. **Cleanup:** `URL.revokeObjectURL(audioUrl)` in `useEffect` cleanup AND before each new generation.
- **Hide replay/splice attack tiles** (lines 178–198). Show only the working clone tile.

**Definition of done:** generate a spoof from a real saved reference sample; Test Detection returns real `deepfake_score` < 0.5 with proper sub-scores; blob URLs don't leak.

#### Y-20 — Mic-permission + recording-failure UX ⬜

- Detect `getUserMedia` denial (Y-12 sets `state === 'denied'`). Render a small "Microphone access required" inline screen with a Retry button — wherever the recorder is mounted (EnrollScreen, console Run-Verification flow).
- Detect `< 1 s` recordings (Y-12 returns `null`). Surface "Recording too short, try again" inline; do not drop the user out of the current screen.
- Confirm Safari + Chrome both produce a WAV the backend accepts.

**Definition of done:** disable mic in the browser, refresh — expect the Retry screen; record < 1 s — expect inline error; both browsers green.

---

## Files Yoav owns

**Frontend (existing):**

- `frontend/src/screens.jsx` — Y-13, Y-14, Y-15
- `frontend/src/more-screens.jsx` — Y-16

**Frontend (new):**

- `frontend/src/lib/audio.ts` — Y-12

**Backend:**

- `backend/app/api/routes.py` — Y-17, Y-18
- `backend/app/services/detector.py` — Y-19
- `backend/app/services/verification.py` — Y-19 wire-up
- `backend/tests/test_users.py` — Y-17 (new)
- `backend/tests/test_spoof.py` — Y-18 (new)

## Coordination notes

- **Y-12 (recorder) is the keystone.** Ship it day 1. Eden's E-17 / E-20 are blocked on it.
- **Blocked by Eden's E-14** for `useCalibratedTimeline` (Y-14) and `lib/session.tsx` (Y-13/Y-15/Y-16).
- **Y-17 + Y-19** are independent — ship in parallel with Y-12 on day 1.
- API contract changes need a 24 h Slack notice; Eden updates `lib/api.ts` types in lockstep.
- **Standing rule:** every UI PR includes a screenshot; every backend PR includes a curl/pytest snippet. Both engineers review each other's PRs end-to-end.
