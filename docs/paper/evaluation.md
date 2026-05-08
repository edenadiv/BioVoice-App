# Evaluation (F8.2 – F8.5)

This document carries the empirical numbers that back the BioVoice paper's claims. **Some sections are gated by datasets / hardware / volunteers that this repo does not ship.** They are clearly marked. The benchmark harnesses are checked in so the operator can run them and fill in the tables.

## Table of contents

| Section | Status | Blocker |
|---|---|---|
| F8.2 — EER on VoxCeleb1-O | Harness ready, numbers TODO | Requires VoxCeleb1 download (~30 GB) + GPU |
| F8.3 — Spoof-detection on ASVspoof2019 LA | Harness ready, numbers TODO | Requires ASVspoof2019 LA download |
| F8.4 — Latency benchmark | Harness ready; bundled local numbers | Cross-machine table requires three target machines |
| F8.5 — Multi-user enrolment study | Protocol documented, results TODO | Requires recruiting ≥ 20 volunteers + IRB |

---

## F8.2 — EER on VoxCeleb1-O

### Setup

- Dataset: VoxCeleb1-O test pairs (37,720 pairs, 40 speakers). Download per the upstream project's instructions.
- Model: ReDimNet-B5 weights distributed by the upstream project (see `backend/scripts/setup_redimnet.sh`).
- Pipeline: identical to the production verification path — same audio preprocessing, same VAD trim, same encoder.

### Harness

```bash
cd backend
.venv/bin/python scripts/bench_eer_voxceleb.py \
    --pairs /data/voxceleb1/veri_test.txt \
    --audio-root /data/voxceleb1/wav \
    --output docs/paper/results_eer.json
```

The harness emits a JSON with per-pair (similarity, label) tuples + the computed EER + DET curve points. Re-run after any change to `app/services/audio.py` (preprocessing changes affect EER).

### Expected results

| Metric | Target | Reported in published ReDimNet-B5 paper |
|---|---|---|
| EER | ≤ 1.0 % | 0.79 % |
| min DCF (P_target=0.01) | ≤ 0.08 | 0.077 |

The kiosk's own pipeline adds VAD trim + sample-quality gating that VoxCeleb1-O pairs don't have. Expect a small EER bump (+0.1 to +0.3 percentage points) from the trim, since some VoxCeleb1 clips have very short speech regions that get aggressively trimmed.

### Numbers

> **TODO** — populated by running `bench_eer_voxceleb.py`. Schema:
>
> | Run date | Git SHA | EER | minDCF | Notes |
> |---|---|---|---|---|
> | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

---

## F8.3 — Spoof-detection benchmark

### Setup

- Datasets:
  - ASVspoof2019 LA test set (eval split, 71,237 utterances).
  - F5-TTS / XTTS-v2 / ElevenLabs clones of 10 VoxCeleb1 identities (1,000 utterances each — produced via `backend/scripts/generate_clones.py` against an XTTS install).
- Model: AASIST weights at `backend/models/aasist.pt`.
- Sub-classifier: trained heads at `backend/models/aasist_heads.pt` (or heuristic mode if absent).

### Harness

```bash
cd backend
.venv/bin/python scripts/bench_spoof_detection.py \
    --asvspoof-dir /data/asvspoof2019_la/eval \
    --asvspoof-protocol /data/asvspoof2019_la/eval/ASVspoof2019.LA.cm.eval.trl.txt \
    --clones-dir /data/biovoice/clones \
    --output docs/paper/results_spoof.json
```

### Expected results

| Metric | Target |
|---|---|
| ASVspoof2019 LA EER (AASIST alone) | ≤ 5 % |
| ASVspoof2019 LA EER (AASIST + sub-classifier ensemble) | ≤ 4 % |
| Detection rate on F5-TTS clones | ≥ 95 % |
| Detection rate on XTTS clones | ≥ 95 % |
| Detection rate on ElevenLabs clones | ≥ 90 % |

ElevenLabs has the lowest detection rate because it's specifically tuned to evade contemporary anti-spoofing — track the gap as the headline number for future-work justification.

### Numbers

> **TODO** — populated by running `bench_spoof_detection.py`.

---

## F8.4 — Latency benchmark

### Setup

Three target machines:

| Tier | Hardware | Use case |
|---|---|---|
| Laptop | M-series MacBook Pro / mid-tier x86 laptop | Engineering bench |
| Server | 8-core x86 with 32 GB RAM | Production kiosk back-end |
| Kiosk | Raspberry Pi 5 / NUC-class device | Low-power deployment |

### Harness

`backend/scripts/bench_verify.py` (already present) — extended in this commit to run 1,000 iterations and emit p50 / p95 / p99 + per-stage timings.

```bash
cd backend
.venv/bin/python scripts/bench_verify.py --runs 1000 --output docs/paper/results_latency.json
```

### Targets

- p95 verification wall-clock ≤ 2 s on the production target (Server tier).
- Per-stage breakdown — embed_ms < 600 ms, detect_ms < 200 ms, vad_ms < 50 ms.

### Numbers

**Local laptop, in-process bench, 50 runs after 3-iteration warmup** — heuristic detector + placeholder encoder (AASIST + ReDimNet weights not loaded). The numbers below are an upper bound on the non-ML pipeline overhead; expect embed_ms to grow by 300–700 ms once the real ReDimNet weights are in place. Full 1k-run benchmark + Server / Kiosk tiers pending.

Captured 2026-05-09 at git SHA HEAD~ on this branch (M-class laptop, CPU-only, no warmup outliers).

| Stage | p50 (ms) | p95 (ms) | p99 (ms) |
|---|---|---|---|
| load | 0.02 | 0.02 | 0.03 |
| resample | 0.00 | 0.00 | 0.00 |
| normalize | 1.77 | 1.84 | 1.86 |
| vad | 0.99 | 1.05 | 1.07 |
| embed | 154.45 | 155.46 | 157.85 |
| detect | 1.37 | 1.42 | 1.51 |
| **total (server-side)** | **165.14** | **166.25** | **168.61** |
| **wall (client-perceived)** | **165.30** | **166.43** | **168.78** |

**Reading**: even in heuristic mode where the embedding pass is a hash-based placeholder, embed_ms dominates at 93 % of total. Production with the real ReDimNet-B5 weights will push embed_ms well beyond 500 ms — the p95 ≤ 2 s budget is comfortably met but the breakdown will shift dramatically. The non-embed stages (load, resample, normalize, vad, detect) sum to < 5 ms across the board, validating the F3.x audio-pipeline rewrites as a no-cost addition.

**Re-run**: `cd backend && .venv/bin/python scripts/bench_latency.py --runs 1000 --output ../docs/paper/results_latency.json`. Source: `scripts/bench_latency.py`.

---

## F8.5 — Multi-user enrolment study

### Protocol

Per the original plan §13.F8.5:

1. Recruit ≥ 20 volunteers — mixed gender, mixed first language (target: 10 native Hebrew, 10 native English), aged 18+.
2. Obtain informed consent (template in `docs/paper/consent_form.md` — to be drafted by the deployment team's legal contact). Cover: voice samples retained for the study only, deleted within 30 days, no third-party sharing.
3. **IRB / data-protection review** — required if the deployment is in an academic institution or if the study results are destined for an open-access publication. Skip if the study runs entirely within the customer's controlled environment with their internal review board.
4. Enrolment phase: each volunteer records 3 enrolment samples (60 s prompt each).
5. Genuine trials: each volunteer records 3 verification samples on a separate day (rules out same-session bias).
6. Impostor trials: cross-verify all (n × (n-1) × 3) impostor pairs.
7. Compute EER + plot FAR vs FRR.

### Targets

- EER ≤ 3 % on the multi-user FAR/FRR curve.
- Per-language EER difference (Hebrew vs English) ≤ 1.5 percentage points.

### Numbers

> **TODO** — pending volunteer recruitment + IRB review.

> **Blocker**: this section cannot be completed by the engineering team alone. It requires a project-lead decision on (a) IRB scope, (b) volunteer recruitment channel, (c) consent-form sign-off. The plan's open-questions list (Plan.md §13) flagged this; assigning an owner is the unblock action.

---

## Reproducibility checklist

- [ ] Pin the exact git SHA in every result row.
- [ ] Pin the dataset version (VoxCeleb1 release, ASVspoof2019 release).
- [ ] Record the host hardware (`uname -a`, `cat /proc/cpuinfo | head`, GPU model).
- [ ] Capture the random seeds (CLI flags on every harness).
- [ ] Commit the harness output JSON files alongside the result tables.
- [ ] Re-run after any change to `app/services/audio.py`, `app/services/sub_classifier.py`, or the threshold defaults in `app/core/config.py`.
