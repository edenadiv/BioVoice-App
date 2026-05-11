# BioVoice — Real Visualizations Plan (v1.0.3)

> **Status**: drafted 2026-05-12 · supervisor-driven · single-kiosk · branch `main`
> **Supersedes**: the v1.0.2 benchmarks plan (closed; B0–B6 shipped at tag `v1.0.2`).
> **Goal**: replace the two remaining schematic / approximate visualizations in the operator console with real data end-to-end. No mocks. No "(schematic)" / "(approx)" labels left in the UI.

---

## Context

The system already loads real ML weights (ReDimNet B5 + AASIST), ships measured EER numbers (LibriSpeech 0.90% / say-spoofs 29.0%), and surfaces model provenance via `DegradedBanner`. Two surfaces in `frontend/src/console-ext.jsx` are still **not** real:

1. **`EmbeddingConstellation` (lines 78-273)** — labelled "schematic" in its own tooltip. Cluster centers are derived from `hash(profile.id)` (line 88) + `seedRandom()` (line 106) + Gaussian noise (line 109) + 90 background "noise" points (line 119). The "live voice comet" (line 232) is `Math.sin(t)` driven, not real audio. **Zero real ReDimNet vectors are involved.**

2. **`LiveFeatures` (lines 279-365)** — labelled "(live mic · approx jitter)". Pitch is a single FFT-bin peak (line 297, no autocorrelation refinement), formants are spectral peaks not LPC roots (line 304), jitter is per-frame F0 variance not cycle-to-cycle period diff (line 318), SNR is a band-energy ratio plus a `+18 dB` heuristic offset (line 333).

The supervisor-facing ask: **"full system working, no mock data"**. This plan covers the visualization layer. Trained sub-classifier heads (G2), XTTS spoof generation (S2), gated VoxCeleb/ASVspoof bench, multi-speaker volunteer study (G4), Postgres (G5), and the restore tool (G7) are explicitly **out of scope** — all carried forward to v1.1.

### What's already in the repo (don't rebuild)

- `users.embedding_json` + `users.sample_embeddings_json` columns + backfill (`backend/app/storage/sqlite_store.py:35-83`). Per-sample 192-d embeddings already stored at enrolment time.
- `verification.py:enroll()` populates `sample_embeddings` (`backend/app/services/verification.py:164,173`). Centroid is `_build_reference_embedding(sample_embeddings)` (line 167).
- `RedimNetSpeakerEncoder.encode(waveform)` (`backend/app/services/speaker_encoder.py`) — production encoder used by every flow.
- `decode_wav_with_timings` + `trim_to_voice` (`backend/app/services/audio.py`) — same pre-processing as `/verify`.
- `useMetricsSummary`, `useCalibratedTimeline`, `useAppDispatch`, `useVoiceRecorder` — existing hook patterns in `frontend/src/lib/`.
- `ModelProvenance` plumbing + `DegradedBanner` — already gates UI on real-vs-fallback. Reuse for the new endpoint responses.

---

## Design

### V1 — Backend `GET /users/embeddings` + `POST /embed`

Two endpoints. No schema migration (storage already has per-sample data).

**`GET /users/embeddings`** — bulk dump of every enrolled profile.
```json
[
  {
    "user_id": "alice",
    "centroid": [192 floats],
    "samples": [[192 floats], [192 floats], [192 floats]],
    "sample_count": 3,
    "enrolled_at": "2026-05-12T12:00:00Z"
  },
  ...
]
```
Source: `SQLiteStore.list_users()` already returns `SpeakerRecord(embedding, sample_embeddings, ...)`. Just expose via Pydantic.

**`POST /embed`** — pure encoder pass for the live point.
- Body: `multipart/form-data` with `audio` file, same as `/verify` (reuse the FastAPI `File(...)` shape).
- Response: `{ embedding: [192 floats], duration_ms: 1500, snr_db: 22.4, frame_count: 24000, model_provenance: {...} }`
- Implementation: new `VerificationService.embed_only(audio_bytes)` method:
  1. `decode_wav_with_timings` → samples
  2. `trim_to_voice` → trimmed
  3. **Skip** the SNR/quality gate (live preview should not 4xx; just return a low-confidence flag)
  4. `encoder.encode(trimmed.waveform)` → 192-d
  5. Return + provenance
- **Does NOT** write to DB. **Does NOT** call detector. **Does NOT** increment metrics. Pure stateless preview.
- Target latency: <100ms on M2 CPU.

### V2 — Frontend `lib/pca.ts` + `lib/dsp.ts`

Two pure-JS modules, fully unit-testable. No new npm dependencies — all written from scratch (~200 LoC each).

**`pca.ts`**:
```ts
export function fitPCA3(vectors: number[][]): { basis: number[][]; mean: number[] };
export function projectPCA3(vector: number[], pca: PCA): [number, number, number];
```
Algorithm: subtract mean → covariance matrix → top-3 eigenvectors via power iteration with deflation (192×192 cov, 3 components, ~200ms one-shot in JS — fine).

**`dsp.ts`** (operates on Float32Array PCM at 16 kHz):
```ts
export function pitchAutocorrelation(samples: Float32Array, sr: number): number;  // Hz, 0 if silence
export function formantsLPC(samples: Float32Array, sr: number, order?: number): [number, number, number];  // F1, F2, F3 in Hz
export function jitterPercent(periodSamples: number[]): number;  // cycle-to-cycle, 0–100
export function snrFromVad(samples: Float32Array, vadMask: boolean[]): number;  // dB
```

Algorithms:
- **Pitch**: Boersma-style autocorrelation over [80, 400] Hz. Window with Hann, normalise by zero-lag, parabolic interpolation around the peak. No FFT needed.
- **Formants**: Pre-emphasis (`α=0.97`) → Hamming window → autocorrelation → Levinson-Durbin to LPC coefficients (order 12 for 16 kHz speech) → polynomial root-finding (Bairstow or Durand-Kerner) → roots inside unit circle → angles → frequencies → return first 3 above 90 Hz with bandwidth filter.
- **Jitter**: cycle-to-cycle relative absolute period difference. Buffer of last N=20 detected periods.
- **SNR**: 10·log10(mean(|samples[vad=true]|²) / mean(|samples[vad=false]|²)). No magic offset.

### V3 — Frontend hooks

**`hooks/useEmbeddingProjection.ts`**:
```ts
export function useEmbeddingProjection(): {
  loading: boolean;
  error: Error | null;
  basis: PCA | null;
  profiles: Array<{
    user_id: string;
    centroidProjected: [number, number, number];
    sampleProjections: Array<[number, number, number]>;
    color: string;
  }>;
  refresh: () => void;
};
```
- Mounts → `getUserEmbeddings()` → `fitPCA3(allCentroids ∪ allSamples)` → projects all, returns memoised. Refits when profile list changes.

**`hooks/useLiveEmbedding.ts`**:
```ts
export function useLiveEmbedding(opts: {
  enabled: boolean;
  audioBuffer: Float32Array | null;
  basis: PCA | null;
  intervalMs?: number;  // default 500
}): {
  liveProjected: [number, number, number] | null;
  liveEmbedding: Float32Array | null;
  loading: boolean;
};
```
- Slices the **last 1500ms** from `audioBuffer`, encodes to WAV (reuse `frontend/src/lib/audio.ts:samplesToWav`), POSTs to `/embed`, projects via `basis`. Polls every `intervalMs` while `enabled`.
- Concurrency: at most one in-flight request; new ones short-circuit. Request budget: 2 req/s.

### V4 — Frontend rewrites

**`EmbeddingConstellation` (`console-ext.jsx:78-273`)** — gut the seeded geometry:
- Remove `centers` (lines 86-99) — replace with `profiles` from `useEmbeddingProjection`.
- Remove `points` (lines 102-132) — render `profile.centroidProjected` as the labelled cluster center, render `profile.sampleProjections` as small orbiting dots (real per-sample dispersion).
- Remove the synthetic background-noise loop (lines 118-130) entirely.
- Remove the `Math.sin(t)` "comet" (lines 232-265) — replace with `liveProjected` from `useLiveEmbedding`. Live point only updates on actual audio; otherwise hidden.
- Update title tooltip from "Schematic — cluster centres are deterministic per profile ID, not real ReDimNet projections" to "Real ReDimNet 192-d → PCA(3). Live point updates while mic is on."

**`LiveFeatures` (`console-ext.jsx:279-365`)** — replace the inline FFT math:
- Drop `freqs` prop. Replace with `samples` (Float32Array PCM at 16 kHz).
- Replace lines 290-312 with `dsp.pitchAutocorrelation` + `dsp.formantsLPC`.
- Replace lines 313-324 with `dsp.jitterPercent` over a period buffer.
- Replace lines 325-333 (including the `+18` SNR fudge) with `dsp.snrFromVad`. VAD mask comes from existing recorder (`audio.level > 0.02` per-frame, already computed).
- Update the parent label in `console.jsx` from `(live mic · approx jitter)` to `(live mic)`.

### V5 — Settings toggle

Add a single boolean in localStorage: `biovoice.constellation.liveOn` (default `true`). Settings panel in `console.jsx` gets a row:

> **Constellation live point** — Stream a 192-d embedding every 500ms to project your live voice into the cluster space. Disable to silence the preview encoder. **[ON / OFF]**

When OFF, `useLiveEmbedding` short-circuits (no requests, no live point rendered). Setting persists across reloads.

### V6 — Tests

**Backend** (`backend/tests/test_embeddings_route.py`, new):
- `GET /users/embeddings` returns 200, list of dicts with `centroid` length 192, `samples[i]` length 192, `sample_count` matches `len(samples)`.
- `GET /users/embeddings` on empty DB returns `[]`.
- `POST /embed` with valid WAV returns 200 + 192-floats + finite SNR + `model_provenance.encoder=="redimnet_b5"`.
- `POST /embed` does NOT write a row (compare `list_results()` count before/after).
- `POST /embed` short audio (<1s) returns 200 with low `frame_count` flag (no 4xx).
- Same audio through `enroll` and `embed` produces identical embedding (within 1e-6 cosine).

**Frontend** (`frontend/src/lib/pca.test.ts` + `dsp.test.ts`, new):
- `pca.test.ts`: synthetic 3-cluster gaussian (3 clusters of 50 points in 50-d) → PCA → cluster means in 3-d are pairwise ≥1.0 apart.
- `pca.test.ts`: identity inputs → projections are zero (within tolerance).
- `dsp.test.ts`: 220 Hz sine, 16 kHz, 0.1s → `pitchAutocorrelation` returns 220 ± 2 Hz.
- `dsp.test.ts`: silent input → pitch returns 0.
- `dsp.test.ts`: synthesised 3-formant signal (sum of 3 narrow-band noise bursts at known F1/F2/F3) → `formantsLPC` returns within ±50 Hz of truth.
- `dsp.test.ts`: stable 220 Hz period buffer → jitter ≈ 0 (<0.1 %); modulated buffer → jitter > 1 %.
- `dsp.test.ts`: known SNR mixture (sine + scaled gaussian, VAD true on sine) → `snrFromVad` within ±1 dB of computed truth.

**Visual smoke (manual, document in `docs/qa.md`)**:
1. Enrol 3 distinct voices (3 samples each).
2. Open Console. Three labelled clusters appear, visibly separated, each with 3 small orbiting sample points.
3. Click VERIFY for one of them. While recording, a bright live point streams through the projection; on completion, it parks near the matching cluster.
4. Toggle the Settings switch off → live point disappears, no `/embed` requests in DevTools network tab.

---

## Phases

### Phase V0 — Sync this plan to repo `Plan.md`
- Copy this file to `Plan.md`, replacing the closed v1.0.2 benchmarks plan.

### Phase V1 — Backend (~3h)
- `backend/app/schemas.py` — `UserEmbedding`, `UsersEmbeddingsResponse`, `EmbedResponse`.
- `backend/app/services/verification.py` — `embed_only(audio_bytes)` method.
- `backend/app/api/routes.py` — register `GET /users/embeddings` + `POST /embed` (multipart audio).
- `backend/tests/test_embeddings_route.py` — new (6 cases above).
- Run `pytest -q -m "not slow"` → all green.

### Phase V2 — Frontend pure modules (~5h)
- `frontend/src/lib/pca.ts` — fit + project, with TS types.
- `frontend/src/lib/dsp.ts` — pitch + formants + jitter + SNR.
- `frontend/src/lib/pca.test.ts` + `dsp.test.ts` — new vitest cases.
- `frontend/src/lib/api.ts` — `getUserEmbeddings()`, `embedAudio(samples)` helpers.
- `frontend/src/types.ts` — `UserEmbeddingPayload`, `EmbedResponsePayload` types.
- Run `pnpm vitest run` → all green.

### Phase V3 — Frontend hooks (~2h)
- `frontend/src/hooks/useEmbeddingProjection.ts` — new.
- `frontend/src/hooks/useLiveEmbedding.ts` — new (with toggle support).

### Phase V4 — Frontend rewrites (~3h)
- `frontend/src/console-ext.jsx` — rewrite `EmbeddingConstellation` + `LiveFeatures`.
- `frontend/src/console.jsx` — wire new hooks, remove "(schematic)" / "(approx jitter)" labels, add settings toggle row.
- Tooltip text updates.

### Phase V5 — Manual smoke + docs (~1h)
- Walk the 4-step manual smoke above. Capture two screenshots (constellation with 3 enrolled, constellation with live point landing).
- `docs/qa.md` — add the visualization smoke to the operator checklist.
- `docs/remaining_work.md` — strike the implicit visualization gaps off.

### Phase V6 — Release v1.0.3 (~30min)
- `CHANGELOG.md` v1.0.3 entry: "Real ReDimNet PCA(3) constellation + real DSP (autocorrelation pitch, LPC formants, cycle-to-cycle jitter, VAD-gated SNR). All `(schematic)` / `(approx)` labels gone."
- `git tag -a v1.0.3 -m "..."` + push.
- Update `docs/audit-v1.0.md` footer: "v1.0.3 closes the visualization-honesty gap."

---

## Critical files

### Backend (modify)
- `backend/app/api/routes.py` — register two new routes
- `backend/app/services/verification.py` — add `embed_only`
- `backend/app/schemas.py` — three new Pydantic types

### Backend (new)
- `backend/tests/test_embeddings_route.py`

### Frontend (modify)
- `frontend/src/console-ext.jsx` — gut + rewrite the two components
- `frontend/src/console.jsx` — wire hooks + settings toggle + label fixes
- `frontend/src/lib/api.ts` — two helper functions
- `frontend/src/types.ts` — two TS types

### Frontend (new)
- `frontend/src/lib/pca.ts` + `pca.test.ts`
- `frontend/src/lib/dsp.ts` + `dsp.test.ts`
- `frontend/src/hooks/useEmbeddingProjection.ts`
- `frontend/src/hooks/useLiveEmbedding.ts`

### Docs
- `Plan.md` — overwrite (V0)
- `docs/qa.md` — add smoke test
- `docs/remaining_work.md` — mark visualization items closed
- `docs/audit-v1.0.md` — v1.0.3 footer
- `CHANGELOG.md` — v1.0.3 entry

---

## Verification (run before tagging v1.0.3)

1. **Backend tests**: `pytest -q -m "not slow"` → all green (existing 97 + 6 new = 103).
2. **Frontend tests**: `pnpm vitest run` → all green.
3. **`/users/embeddings`** smoke: `curl localhost:8000/users/embeddings | jq '.[0].centroid | length'` → 192.
4. **`/embed`** smoke: post a recorded WAV → response has `embedding` length 192, `model_provenance.encoder == "redimnet_b5"`.
5. **No `(schematic)` / `(approx)`** strings remain in `frontend/src/`: `rg -i "schematic|approx jitter" frontend/src/` returns nothing.
6. **Visual smoke**: 4-step manual walk above passes.
7. **Settings toggle**: flipping it off stops `/embed` requests within 1s.
8. **Bundle size**: `pnpm build` → gzipped main bundle still under 90 KB (PCA + DSP add ~6 KB; budget allows).
9. **Tag**: `git tag v1.0.3` + push.

---

## UX preference (locked in this brainstorm)

- **Live point in constellation = always-on by default**, with a settings toggle to disable. Encoder budget ~2 req/s while mic is granted; toggle off stops the stream entirely. (User: "always on with ability in setting to turn off".)

---

## Effort summary

| Phase | What | Engineer-hours |
|---|---|---|
| V0 | Sync plan to Plan.md | 0.2 |
| V1 | Backend endpoints + tests | 3 |
| V2 | Pure-JS PCA + DSP modules + tests | 5 |
| V3 | React hooks | 2 |
| V4 | Component rewrites + label fixes | 3 |
| V5 | Manual smoke + doc updates | 1 |
| V6 | Release v1.0.3 | 0.5 |
| **Total** | | **~15 engineer-hours (~1.5 days)** |

Critical path: V2 (the LPC + autocorrelation implementations) — everything else is mechanical wire-up.

Out of scope (carried forward to v1.1):
- G2 trained sub-classifier heads
- S2 XTTS voice cloning
- G4 multi-speaker volunteer study
- G5 Postgres
- G7 restore tool
- Gated VoxCeleb1-O / ASVspoof 2019 LA bench (operator can run anytime via `--dataset-name` flags already in place)
