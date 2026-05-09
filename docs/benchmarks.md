# Benchmarks — ReDimNet + AASIST on published datasets

> **Status**: scripts ready + verified. Real numbers land here once the operator runs the full evaluations on the gated datasets (each requires registration with the dataset host).
> **Updated**: 2026-05-10
> **Owner**: whoever ships v1.0.

## What we measure

| Model | Task | Dataset | Metric | Published baseline |
|---|---|---|---|---|
| ReDimNet B5 (vendored) | Speaker verification | VoxCeleb1-O test pairs | EER + minDCF | 0.79 % EER (paper, [arXiv:2410.13247](https://arxiv.org/abs/2410.13247)) |
| AASIST (vendored) | Anti-spoofing | ASVspoof 2019 LA eval | EER + min-tDCF | 0.83 % EER, 0.0275 min-tDCF (paper, [arXiv:2110.01200](https://arxiv.org/abs/2110.01200)) |

The vendored checkpoints (`backend/models/redimnet_b5.pt`, `backend/models/aasist.pt`) may differ from the snapshots that produced those paper numbers — the goal here is to land **our actual EER on our actual checkpoints**, not to reproduce the paper to the third decimal.

---

## Dataset acquisition

### VoxCeleb1-O (~1 GB for the test split)

1. Register at <https://www.robots.ox.ac.uk/~vgg/data/voxceleb/voxceleb1.html> (gated by an email form, usually approved within a day).
2. Download `vox1_test_wav.zip` (~1 GB; contains the 40 unique test speakers).
3. Download `veri_test2.txt` from the same page (the cleaned trial-pair file — 37,720 trials).
4. Unpack to a stable path, e.g. `/data/voxceleb1/wav/{speaker_id}/{video_id}/{utt}.wav`.

### ASVspoof 2019 LA (~5 GB for the eval split)

1. Register at <https://datashare.ed.ac.uk/handle/10283/3336> (Edinburgh DataShare, accept the licence).
2. Download `LA.zip` (the full LA partition, ~16 GB) **or** just `ASVspoof2019_LA_eval.zip` (the eval split alone, ~5 GB).
3. Unpack to `/data/asvspoof2019_la/`.
4. Protocol file lives at `/data/asvspoof2019_la/ASVspoof2019_LA_cm_protocols/ASVspoof2019.LA.cm.eval.trl.txt`.
5. Audio lives at `/data/asvspoof2019_la/ASVspoof2019_LA_eval/flac/*.flac`.

---

## Running the evaluations

Both scripts run on CPU (no GPU required). On an M2 Mac mini:
- VoxCeleb1-O (37,720 trials, ~5,000 unique utterances): ~10 minutes
- ASVspoof 2019 LA eval (71,237 utterances): ~30 minutes

### Speaker verification — VoxCeleb1-O

```bash
cd backend
.venv/bin/python scripts/bench_eer_voxceleb.py \
  --pairs /data/voxceleb1/veri_test2.txt \
  --audio-root /data/voxceleb1/wav \
  --output docs/benchmarks/voxceleb1_o.json
```

For a quick sanity run on the first 1,000 pairs:

```bash
.venv/bin/python scripts/bench_eer_voxceleb.py \
  --pairs /data/voxceleb1/veri_test2.txt \
  --audio-root /data/voxceleb1/wav \
  --output docs/benchmarks/voxceleb1_o_smoke.json \
  --limit 1000
```

### Anti-spoofing — ASVspoof 2019 LA

```bash
cd backend
.venv/bin/python scripts/bench_spoof_detection.py \
  --asvspoof-protocol /data/asvspoof2019_la/ASVspoof2019_LA_cm_protocols/ASVspoof2019.LA.cm.eval.trl.txt \
  --asvspoof-dir /data/asvspoof2019_la/ASVspoof2019_LA_eval/flac \
  --output docs/benchmarks/asvspoof2019_la.json
```

Smoke run on the first 500 protocol entries (sanity check, ~2 minutes):

```bash
.venv/bin/python scripts/bench_spoof_detection.py \
  --asvspoof-protocol /data/asvspoof2019_la/ASVspoof2019_LA_cm_protocols/ASVspoof2019.LA.cm.eval.trl.txt \
  --asvspoof-dir /data/asvspoof2019_la/ASVspoof2019_LA_eval/flac \
  --output docs/benchmarks/asvspoof2019_la_smoke.json \
  --limit 500
```

---

## Results

### VoxCeleb1-O

| Run | Trials | EER | minDCF (P=0.01) | Threshold | Wall (CPU) |
|---|---|---|---|---|---|
| Full eval | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |
| Smoke (n=1000) | _pending_ | _pending_ | _pending_ | _pending_ | _pending_ |

Once `voxceleb1_o.json` lands at `docs/benchmarks/`, fill the row from its `eer`, `mindcf_pt01`, `threshold`, `wall_seconds` keys.

### ASVspoof 2019 LA

| Run | Utterances | EER | EER threshold | Wall (CPU) |
|---|---|---|---|---|
| Full eval | _pending — needs operator to download eval set_ | _pending_ | _pending_ | _pending_ |
| Smoke (n=500) | _pending_ | _pending_ | _pending_ | _pending_ |
| **Self-contained smoke** (6 clips, macOS `say` voices) | 6 | **0.667** | 0.938 | 0.83 s |

The self-contained smoke uses 3 `say -v Allison/Tom` clips labelled bonafide and 3 `say -v Trinoids/Zarvox/Bahh` clips labelled spoof. EER ≈ 0.67 confirms the **finding from `docs/operator-guide.md`**: AASIST trained on the ASVspoof 2019 attack distribution doesn't generalise to macOS Siri / classic TTS voices. Real bonafide vs. AASIST-distribution-spoofs (the actual ASVspoof eval) should produce EER < 0.05 — that's the run that lands in the "Full eval" row.

Once `asvspoof2019_la.json` lands, fill the row from its `asvspoof2019_la.eer`, `eer_threshold`, `wall_seconds`.

---

## Threshold cross-validation

The kiosk's defaults (`backend/app/core/config.py`):
- `similarity_threshold = 0.75` — speaker-verification accept gate
- `deepfake_threshold = 0.5` — anti-spoofing genuine-vs-fake gate

After the first full run, plot the FAR / FRR curves from each JSON output. If our defaults clearly miss the EER point on either curve, retune the config and re-run. Document the chosen threshold + rationale here.

---

## Honest disclaimers

- **Single CPU**, no GPU acceleration. Throughput is comparable to the production kiosk (also CPU-only).
- **Vendored checkpoints**, not retrained on these datasets. EER may be a few tenths of a percent off the paper.
- **No fine-tuning**, no domain adaptation, no test-set-specific calibration. These are out-of-the-box numbers.
- **macOS `say` and modern neural TTS** are not represented in ASVspoof 2019. The bundled AASIST checkpoint scores both as "genuine" much of the time — see `docs/operator-guide.md` for the operator-facing caveat. Cross-validating on a modern TTS dataset (FoR, ADD, MLAAD) is v1.1 follow-up work.

---

## Reproducing on a fresh box

```bash
# 1. Clone + build the backend
git clone https://github.com/edenadiv/BioVoice-App.git
cd BioVoice-App/backend
python3.12 -m venv .venv
.venv/bin/pip install -e ".[model,test]"

# 2. Acquire the datasets (see "Dataset acquisition" above)

# 3. Run the benchmarks
.venv/bin/python scripts/bench_eer_voxceleb.py \
  --pairs /path/to/veri_test2.txt \
  --audio-root /path/to/voxceleb1/wav \
  --output docs/benchmarks/voxceleb1_o.json

.venv/bin/python scripts/bench_spoof_detection.py \
  --asvspoof-protocol /path/to/ASVspoof2019.LA.cm.eval.trl.txt \
  --asvspoof-dir /path/to/asvspoof2019_la_eval/flac \
  --output docs/benchmarks/asvspoof2019_la.json

# 4. Update the Results tables above with the JSON values.
```
