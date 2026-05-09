# Sub-classifier methodology (F4)

## 1. Motivation

The verification UI exposes four per-concept scores alongside the global accept/reject decision:

| Axis | What it measures |
|---|---|
| `voice_naturalness` | How harmonic / vocal-like the recording is (HNR, voiced ratio) |
| `spectral_consistency` | Coherence of the spectrum across time (low spectral flatness) |
| `temporal_patterns` | Naturalness of prosody (F0 variation in the conversational range) |
| `artifact_detection` | Inverse score: high = few synthetic artifacts |

Pre-F4 the four values were derived by perturbing the global AASIST deepfake score with seeded jitter — they conveyed no per-axis information. F4 replaces that placeholder with `AcousticProbe`, a feature-based classifier that produces axis-specific values from the actual recording.

## 2. Architecture

```
   raw 16 kHz mono ──► acoustic_features.extract ──► 75-D vector ─┐
                                                                  │
                            ┌─── voice_naturalness head (MLP 75→64→1)
                            ├─── spectral_consistency head
                  AcousticProbe ──┤
                            ├─── temporal_patterns head
                            └─── artifact_detection head
```

Each head is independent — we treat the four axes as parallel regression problems. The MLP architecture is intentionally small (4,929 parameters per head) so the four heads add only ~80 KB to the model bundle.

## 3. Heuristic mode (no trained heads bundled)

When `Settings.sub_classifier_heads_path` is `None` (the default in this codebase), `AcousticProbe._score_heuristic` is used. Each axis maps directly onto interpretable features:

| Axis | Heuristic |
|---|---|
| `voice_naturalness` | `0.6 · sigmoid(HNR_dB; centre=8, scale=4) + 0.4 · voiced_ratio` |
| `spectral_consistency` | `1.0 − min(1, mean_spectral_flatness / 0.5)` |
| `temporal_patterns` | `0.7 · prosody_score + 0.3 · voiced_ratio`, where `prosody_score = max(0, 1 − |F0_std − 45| / 60)` |
| `artifact_detection` | `0.5 · sigmoid(HNR_dB; centre=8, scale=4) + 0.5 · spectral_consistency` |

The constants come from a small calibration run on TIMIT-style clean speech (HNR ≈ 12 dB, F0 std ≈ 30–60 Hz for relaxed prosody, spectral flatness ≈ 0.05–0.20). The heuristic is a real, audio-derived computation — every recording produces a different per-axis score — but it is not a learned model.

## 4. Trained-head mode (production target)

### 4.1 Dataset

| Source | Use | Size |
|---|---|---|
| VoxCeleb1 | High-naturalness positive samples | ≥ 2,000 clips |
| ASVspoof2019 LA train+dev | Synthetic / replay negatives | ≥ 2,000 clips |
| F5-TTS / XTTS / ElevenLabs clones | Recent-tech synthetic negatives | ≥ 1,000 clips |
| Total target | | ~5,000 |

### 4.2 Annotation schema

Each clip is annotated on the four axes as a continuous score in `[0, 1]`. Two paths:

1. **Hand-annotated** — three expert reviewers per clip, Krippendorff's α ≥ 0.7 across reviewers. Required for the published paper numbers.
2. **Proxy-labelled** — `scripts/build_proxy_labels.py` (planned in F8) computes the four axes from raw acoustic metrics (HNR for naturalness, spectral flatness for consistency, etc.) and uses those as bootstrap labels. Faster to scale; lower ceiling on accuracy. Used to train the v0 heads while hand-annotation is in flight.

Manifest format:

```csv
path,voice_naturalness,spectral_consistency,temporal_patterns,artifact_detection
voxceleb1/id00001/clip001.wav,0.92,0.85,0.78,0.90
asvspoof2019_la/LA_T_0000001.wav,0.20,0.45,0.30,0.15
…
```

### 4.3 Training

```bash
cd backend
.venv/bin/python scripts/train_sub_classifier.py \
    --manifest /data/sub_classifier/train.csv \
    --output models/aasist_heads.pt \
    --epochs 50 \
    --report-thresholds
```

The script:

- Loads each clip's audio, runs `acoustic_features.extract`, and stacks into `X` (N × 75).
- Splits 70 / 15 / 15 with a deterministic seed (= 42) for reproducibility.
- Trains four MLP heads with Adam + BCE-with-logits loss for `--epochs` (default 50).
- With `--report-thresholds`, computes per-axis EER thresholds on the validation set and prints them so they can be folded into `Settings.{axis}_threshold` (F4.4).

Saved to `backend/models/aasist_heads.pt` as a dict-of-state-dicts. The runtime `AcousticProbe._ensure_loaded` detects the file on first `.score()` call and switches to trained-head mode.

### 4.4 Evaluation

Held-out test split (15 % of the corpus). For each axis we report:

- Pearson r between predicted and annotated score
- EER on the binary positive/negative split (label > 0.5)
- 95 % CI on both, bootstrap with 10,000 resamples

Target: **r > 0.6 per axis** on the test split. Below 0.6 means the heads aren't doing better than the heuristic — accept the result as evidence that this corpus's labels need a more discriminating feature set, and document accordingly in F8.

## 5. Per-concept thresholds (F4.4)

`Settings` exposes:

```python
voice_naturalness_threshold: float = 0.45
spectral_consistency_threshold: float = 0.50
temporal_patterns_threshold: float = 0.40
artifact_detection_threshold: float = 0.45
```

These are surfaced in the operator UI (F6.3 — Threshold Tuning page). The current contract: thresholds are display-only — the global accept/reject decision uses only `similarity_threshold` and `deepfake_threshold`. A future iteration may down-grade an "ACCEPT" to "REVIEW" when a sub-axis falls below threshold; that requires a separate review queue + UX, slated for post-Δ-1.

## 6. Limitations

- **Heuristic mode is calibrated for adult speech.** Children's voices have different HNR + F0 statistics and may score artificially low on `voice_naturalness`. Future work: per-demographic calibration.
- **The 75-D feature vector is microphone-agnostic by construction.** It will not pick up artifacts that show up only at very high frequencies (> 7.5 kHz) — anything that lives outside the 16 kHz Nyquist limit. For deepfake families that target the high-frequency band (some neural vocoders), a 24 kHz capture path + extended feature set is the F8 follow-up.
- **No per-language adaptation.** Hebrew vs. English speech statistics differ slightly (vowel inventory, prosody contours). The F5 RTL/Hebrew work doesn't change the sub-classifier; the F8 multi-user study includes both languages so the test-set numbers reflect the Hebrew use case. Production monitoring should track per-language EER drift.
