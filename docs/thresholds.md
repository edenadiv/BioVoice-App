# Decision thresholds — what they gate, how to tune them

> Audit finding F-4: the v1.0 defaults (similarity 0.75, deepfake 0.50) are SDD conventions, not calibrated values. This page is the documented rationale + retune procedure until the benchmarks (Plan.md §S3) land real EER curves.

---

## Where they live

`backend/app/core/config.py:Settings`:

```python
similarity_threshold: float = 0.75
deepfake_threshold: float = 0.50
```

Both are read at app startup. Override via the `Settings` constructor or by editing the defaults and restarting the backend (`docker compose restart backend`).

---

## The decision logic

`backend/app/services/verification.py:_decide()`:

```
if deepfake_score < deepfake_threshold:
    → DEEPFAKE
elif similarity_score >= similarity_threshold:
    → ACCEPT
else:
    → REJECT
```

The deepfake gate fires *before* the similarity check — even a perfect voice match is rejected if AASIST flags the audio as synthetic.

---

## Operating-point trade-offs

### `similarity_threshold` (cosine similarity, [0, 1])

| Value | Effect | When to pick |
|---|---|---|
| **0.60** | Very permissive — accepts even loose matches | Operator wants minimum friction; security loss tolerable |
| **0.70** | Permissive | Indoor kiosk, single operator's voice, low FAR concern |
| **0.75** (default) | Balanced — SDD convention | Generic starting point, no calibration data yet |
| **0.85** | Strict | Multi-operator deployment, higher security stakes |
| **0.95** | Very strict | Adversarial-testing demo, want to show false rejects |

What changes:
- **Lower threshold** → more **false accepts** (FAR ↑ : a different speaker's voice gets approved). Worse for security, better for operator throughput.
- **Higher threshold** → more **false rejects** (FRR ↑ : the legitimate operator gets rejected). Worse for usability, better for security.

The right answer is dataset-calibrated. See Plan.md §S3 for the path.

### `deepfake_threshold` (AASIST score, [0, 1])

AASIST returns a probability that the audio is **genuine** (1.0 = clean human speech, 0.0 = clearly synthetic). The threshold is the cutoff below which we say DEEPFAKE.

| Value | Effect | When to pick |
|---|---|---|
| **0.30** | Permissive — most synthetic audio passes through | Don't use; defeats the detector |
| **0.50** (default) | Balanced — SDD convention | Generic starting point |
| **0.70** | Strict | High-security demo, but expect more false DEEPFAKE on real noisy audio |
| **0.90** | Very strict | Adversarial-testing demo only |

**v1.0 known limitation**: the bundled AASIST checkpoint is trained on the ASVspoof attack distribution and **does not reliably catch macOS Siri / `say` voices**. With the system-TTS spoof fallback, even 0.50 won't flag the audio. XTTS-v2 cloning artefacts WILL register at 0.50. See `docs/operator-guide.md` and the audit at `docs/audit-v1.0.md`.

---

## Retuning procedure

1. **Acquire benchmark data** — see Plan.md §S3 (`backend/scripts/bench_eer_voxceleb.py`, `bench_spoof_detection.py`). Datasets are gated; the operator runs the scripts locally on a downloaded copy.
2. **Run the benchmarks**, get a CSV of `(score, label)` per utterance.
3. **Plot the FAR / FRR curves** at varying thresholds. The crossing point is the EER (equal-error rate); pick the threshold there for the balanced operating point. If your security model is asymmetric, pick the threshold where one error rate is acceptable.
4. **Edit `backend/app/core/config.py`** with the chosen values.
5. **Restart the backend** (`docker compose restart backend`).
6. **Re-test against your operator's voice** on the live kiosk to confirm the decision feels right.
7. **Document the change** in `docs/benchmarks.md` with the chosen value, the EER curve plot, and the date of calibration.

---

## When to revisit

- After Plan.md §S3 (real benchmark numbers): retune to the EER point.
- After Plan.md §S2 (XTTS-v2): the deepfake threshold may need to move once XTTS clones are in the test set — they're harder to catch than `say`.
- After any retraining of AASIST or ReDimNet — thresholds are sensitive to the model's score distribution.

Until any of those land, **the defaults are placeholders**, not validated values.

---

## Calibration history

### v1.0.2 — 2026-05-10 — measured but not retuned

First real measurement against public data (Plan §B4). Both thresholds checked, both kept at v1.0 defaults. Reasoning:

| Threshold | Default | Measured EER point | Decision | Why |
|---|---|---|---|---|
| `similarity_threshold` | 0.75 | 0.387 (LibriSpeech test-clean, 8000 trials) | **Keep 0.75** | LibriSpeech is studio audio. Lowering to 0.387 in production (USB mic + real room) would spike false accepts on different speakers. Need real-room labelled data to retune confidently. |
| `deepfake_threshold` | 0.50 | 0.977 (LibriSpeech bonafide vs `say` spoofs, 600 clips) | **Keep 0.50** | Degenerate measurement: AASIST scores `say` spoofs in the 0.95–0.99 range alongside bonafide. EER point lands at the histogram overlap (top of the score range), not at a meaningful operating point. The right fix is better attack distribution (XTTS-v2 / ADD), deferred to v1.1. |

Per-utterance scores + DET / ROC plots: see `docs/benchmarks.md`.

Next calibration window: after v1.1 lands real XTTS clones in the test set + a few real operators record voice samples in real-room conditions.
