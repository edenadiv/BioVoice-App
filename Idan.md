# Idan — Tasks

> Owner: Idan Shavit. Cross-references `Plan.md` (master plan).
> **Role on this milestone:** Backend lead. Owns FastAPI route additions, model glue, deepfake sub-score derivation, verification record extensions, and infra hygiene. Idan is the gatekeeper for the API contract.

> **Status legend:** ⬜ pending · 🟡 in progress · ✅ done · ⛔ blocked

---

## Sprint 1 — Cleanup + contract

### I-1. Phase 0 audit (backend) ⬜

- Grep `backend/` for any TCAV-related symbols, imports, comments, or routes. None should exist today, but confirm. If any are introduced before this milestone lands, drop them.
- Sanity-check all FastAPI routes load (`uvicorn app.main:app --reload` from `backend/`). Document any startup warnings.
- Confirm `services/speaker_encoder.py` warm-loads ReDimNet on boot so the first verify request stays under the 2 s budget.

**Definition of done:** clean `uvicorn` boot, no TCAV references, latency note appended to `Plan.md` §6.

### I-2. ID-availability endpoint (Phase 8) ⬜

```http
GET /users/{user_id}/availability  →  { "available": true|false }
```

- No auth.
- 200 with `{ available: bool }`. Validate `user_id` against `^[a-zA-Z0-9_\-\.]{3,32}$`. Return 422 on bad shape.
- Backed by `VerificationStore.get_speaker(user_id) is None`.

**Definition of done:** Yoav can call it from the Enroll screen and get a stable `available` boolean. Add a lightweight pytest under `backend/tests/test_users.py` (create the file if missing).

### I-3. Verification record extensions (Phase 8) ⬜

Extend `VerificationResponse` (and `VerifyResult` model) with:

```python
class VerificationResponse(BaseModel):
    # ... existing fields ...
    session_id: str               # "VRF-2026-0508-AB12" formatted
    stage_breakdown: StageBreakdown
    analysis_details: AnalysisDetails  # see I-5
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
- Persist `analysis_details` and `stage_breakdown` on `VerificationRecord.metadata` so historical queries return them.

**Definition of done:** existing `/verify` and `/me/verify` responses include the new fields without breaking the frontend's existing typed parsers (frontend `api.ts` will pick them up via Eden's screen work).

### I-4. View-details endpoint (Phase 8) ⬜

```http
GET /me/verifications/{result_id}  →  VerificationResponse
```

- Auth required. 404 if `result_id` doesn't belong to the authenticated `user_id`.
- Returns the full record built by I-3.

**Definition of done:** Eden's "View Details" modal (E-5) wires to this endpoint and renders centroid, per-sample similarities, and stage breakdown.

### I-5. Deepfake analysis details (Phase 5 / 8) ⬜

`detector.py` currently returns a single AASIST score. The Deepfake Result screen (Fig. 17) shows four sub-metrics. We will derive them deterministically.

```python
def analysis_details_from_score(score: float, *, seed_audio_hash: str) -> AnalysisDetails:
    """
    Deterministic derivation of UI-facing sub-scores from the global AASIST score.
    Each sub-metric is anchored to `score` with seeded jitter (±0.02) so the bars
    look richly resolved without lying about precision. The derivation is
    documented in the research paper appendix (see Plan.md §6 risks table).
    """
```

- Sub-metrics: `voice_naturalness`, `spectral_consistency`, `temporal_patterns`, `artifact_detection`. The first three should track `score`; `artifact_detection` should track `1 - score` (high = many artifacts found = synthetic).
- Seed must be `seed_audio_hash` (stable per-audio) so re-asking returns the same result.
- Bound each in `[0.0, 1.0]`.
- Unit test: 100 random scores produce sub-scores within ±0.02 of expectation.

**Definition of done:** every `VerificationResponse.analysis_details` is populated; values are stable across repeated calls on the same audio. Document the derivation in `Plan.md` §6 and in a code comment above the function.

### I-6. Spoof-test endpoint (Phase 7 / 8) ⬜

```http
POST /me/spoof/test
  multipart audio: WAV
  →  { "deepfake_score": 0.04, "decision": "FAKE" | "GENUINE", "analysis_details": {...} }
```

- Auth required.
- Reuses `DeepfakeDetectorService.detect()` and `analysis_details_from_score()`.
- `decision = "FAKE"` if `deepfake_score < 0.5`, else `"GENUINE"`.
- Latency must stay under 200 ms (we're not running full verification).

**Definition of done:** Yoav can post the freshly generated spoof WAV and render the result in the Test Lab status footer.

---

## Sprint 2 — Hardening

### I-7. Decision logic alignment with SDD §2.5 ⬜

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

**Definition of done:** all three decisions have stable, copy-locked messages and machine-readable reasons.

### I-8. Test coverage ⬜

- `tests/test_verification.py` — happy path, mismatch, deepfake.
- `tests/test_users.py` — availability endpoint.
- `tests/test_spoof.py` — spoof generation and the new `/me/spoof/test`.
- Use FastAPI's `TestClient` with the in-memory store fixture.

**Definition of done:** `pytest backend/tests` is green in CI / locally.

### I-9. Performance probe ⬜

- Add a one-shot script `backend/scripts/bench_verify.py` that posts 10 verifications against the running server and prints p50/p95 timings + the new `stage_breakdown`.
- Confirm p95 < 2 s on Idan's dev box. Append numbers to `Plan.md` §6 risks table.

---

## Files Idan owns

- `backend/app/api/routes.py` (additions only)
- `backend/app/schemas.py` (additions: `StageBreakdown`, `AnalysisDetails`, extended `VerificationResponse`)
- `backend/app/services/verification.py` (timings, session id, decision messages)
- `backend/app/services/detector.py` (analysis details, hashing)
- `backend/app/services/spoof.py` (already exists; ensure the `/me/spoof/test` integration)
- `backend/tests/*` (new)
- `backend/scripts/bench_verify.py` (new)

## Coordination notes

- **Blocks Eden** on I-3 + I-4 before E-5 can ship.
- **Blocks Yoav** on I-2 before he can finish the Enroll screen's ID-Available pill, and on I-5 + I-6 before the Test Lab and Deepfake Result screens can render real data.
- API contract changes go through a 24 h notice in the team channel; Yoav and Eden update their typed parsers in lockstep.
