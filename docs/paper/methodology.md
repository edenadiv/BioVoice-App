# Methodology (F8.1)

## 1. System overview

BioVoice is a voice-biometric authentication kiosk. A user enrols by recording three speech samples; subsequent verification compares a fresh sample to the enrolled centroid, gated by a deepfake detector and a sample-quality estimator. The system is designed for a single-operator kiosk deployment in a controlled environment (e.g. a building entrance) and explicitly **not** for unsupervised authentication over the public internet.

The end-to-end pipeline:

```
microphone → AudioWorklet recorder (F3.1) → 16 kHz mono WAV (lib/audio.ts)
          → POST /me/verify (F2.5 cookie auth)
          → AudioService.decode_wav (16 kHz canonicalisation, ±1.0 normalisation)
          → AudioService.score_quality (F3.3) ─reject low-quality─→ 400
          → AudioService.trim_to_voice  (F3.2) ─reject silence──→ 400
          → ReDimNet-B5 speaker embedding
          → AASIST deepfake score
          → AcousticProbe (F4) — 4-axis sub-classifier
          → decision (ACCEPT / REJECT / DEEPFAKE) per SDD §2.5
```

## 2. Components

### 2.1 Speaker embedding

ReDimNet-B5 [Yakovlev et al. 2024], 16 kHz input, 192-dim output. Pre-trained on VoxCeleb2 (no fine-tuning by us). The model handles its own mel-spectrogram extraction internally — `app/services/speaker_encoder.py` only feeds raw float waveforms.

Centroid: per-user, the mean of L2-normalised sample embeddings. Verification computes both the cosine similarity to the centroid and the cosine similarity to each individual enrolled sample, then takes the average of the centroid score and the top-2 sample scores. This protects against one outlier sample skewing the centroid.

### 2.2 Deepfake detection

AASIST [Jung et al. 2022], pre-trained on ASVspoof2019 LA. We use the model unchanged at inference; `app/services/detector.py` only normalises peak amplitude to 0.05 (matching the training distribution) and pads / truncates to 64,600 samples. The output `softmax[1]` is the probability of "bonafide" — recorded as `deepfake_score` in the verification result. Threshold default 0.50; tunable per-deployment via the F4.4 admin route.

### 2.3 Sub-classifier (F4)

`AcousticProbe` (`app/services/sub_classifier.py`) produces four per-axis scores:

| Axis | What it measures | Heuristic mode formula | Trained mode |
|---|---|---|---|
| voice_naturalness | Vocal harmonicity + voicing | 0.6 · σ(HNR_dB; centre=8) + 0.4 · voiced_ratio | MLP head |
| spectral_consistency | Tonal vs. broadband content | 1 − min(1, mean_flatness / 0.5) | MLP head |
| temporal_patterns | Prosody-like F0 variation | 0.7 · prosody_score + 0.3 · voiced_ratio | MLP head |
| artifact_detection | Inverse synthetic-artifact score | 0.5 · σ(HNR_dB; centre=8) + 0.5 · spectral_consistency | MLP head |

Heuristic mode operates on a 75-D acoustic feature vector (32 log-mel-energy means + 32 stds + spectral centroid mean/std + spectral flatness mean/std + ZCR mean/std + F0 mean/std + voiced ratio + HNR + spectral rolloff). Trained mode loads four 75 → 64 → 1 MLPs from `backend/models/aasist_heads.pt` when present. See `docs/paper/sub_classifier.md` for the training pipeline.

### 2.4 Voice activity detection (F3.2)

Energy-based with adaptive threshold:

- 30 ms frames at 50 % overlap.
- Per-frame mean-square energy.
- Noise floor estimated as the median of the bottom-decile frame energies.
- A frame is "speech" iff energy > max(noise_floor · 4, 1e-5).
- For uniform-energy signals (no silent frames — synthetic test fixtures or sustained loud speech), an absolute threshold replaces the relative one.
- Hangover: bridge silent gaps shorter than 200 ms, pad each region by 80 ms.

Recordings with < 1 s of detected speech raise `NoSpeechDetectedError` → HTTP 400 before the embedding stage runs.

### 2.5 Sample quality scoring (F3.3)

Three metrics:

- **SNR** (dB): derived from the same frame-energy split as VAD. Returns a 60 dB sentinel for tonal uniform signals (mean ZCR < 0.05) so synthetic test tones don't false-fail.
- **Clipping %**: fraction of samples in plateau runs of ≥ 3 consecutive samples with |s| > 0.999. Rejects true digital saturation; tolerates isolated peaks from sine crests.
- **Speech ratio**: voiced seconds (from VAD) ÷ total seconds.

Aggregate score is the geometric mean of the three normalised sub-scores ×100. Defaults: SNR ≥ 10 dB, clipping ≤ 1 %, speech ratio ≥ 0.30; below any threshold the sample is rejected with a per-axis message.

## 3. Decision logic (SDD §2.5)

```
if deepfake_score < deepfake_threshold:
    decision = "DEEPFAKE"
elif similarity_score >= similarity_threshold:
    decision = "ACCEPT"
else:
    decision = "REJECT"
```

Defaults: similarity_threshold = 0.75, deepfake_threshold = 0.50. The deepfake gate runs before the similarity gate so a detected synthetic always rejects, regardless of who it claims to be.

## 4. Threat model

In scope:

- **Spoofing via TTS / VC** (XTTS-v2, F5-TTS, ElevenLabs). AASIST + the F4 sub-classifier are the primary defence.
- **Replay attacks** (recorded enrolment played back). Future work: challenge-response phrase (the F2 risk register).
- **Brute-force authentication** (repeated login attempts). F2.2 rate-limits (user_id, source IP) pairs.
- **Session token theft via XSS** (cookies). F2.5 sets HttpOnly + Secure + SameSite=Strict.
- **Stolen admin credentials**. F6 admin routes are gated by a dedicated API key with rotation policy documented in `backend/README.md` § Secrets.

Out of scope (Δ-1):

- **Active man-in-the-middle on the LAN** between kiosk and operator. Mitigation: TLS termination at the kiosk; the deployment doc explicitly requires it.
- **Hardware compromise** of the kiosk itself. Mitigation: physical security + the operator's local incident playbook.
- **Insider threats** with admin API key access. Mitigation: audit log (F6.2) + key rotation (F2.4).

## 5. Reproducibility

- Code: this repo at the tagged release.
- Models: AASIST weights + ReDimNet-B5 weights, both downloadable from the upstream projects (links in `backend/scripts/setup_*.sh`).
- Datasets: VoxCeleb1, ASVspoof2019 LA — public download, registration required.
- Random seeds: pytest fixtures use seed 0; the sub-classifier training script defaults to seed 42 (set inline; see `scripts/train_sub_classifier.py`).
- Hardware: benchmark numbers in §F8.4 are reported per machine; replicate on equivalent hardware (CPU-only laptop, mid-tier server, low-power kiosk).
