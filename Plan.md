# BioVoice — Real-Dataset Benchmarks Plan (v1.0.2)

> **Status**: drafted 2026-05-10 · supervisor-driven · single-kiosk Mac/Linux · branch `main`
> **Supersedes**: the v1.0.1 audit-fix plan (kept in git history; tag `v1.0.1`).
> **Goal**: replace `_pending_` rows in `docs/benchmarks.md` with actual EER + min-tDCF numbers from ASVspoof 2019 LA + VoxCeleb1-O. Tag v1.0.2.

---

## Context

`docs/benchmarks.md` currently cites paper baselines (0.79 % ReDimNet on VoxCeleb1-O, 0.83 % AASIST on ASVspoof) and marks the actual-measurement rows `_pending_`. The benchmark scripts at `backend/scripts/bench_eer_voxceleb.py` + `bench_spoof_detection.py` are wired and verified end-to-end (a 6-clip self-contained smoke runs in 0.83 s and produces real AASIST scores). What's missing is the **real run on the gated datasets**, which the audit (`docs/audit-v1.0.md` F-4) called out as the path to data-driven thresholds.

The supervisor-facing ask: **publishable EER + min-tDCF + min-DCF numbers** for both subsystems on the standard public benchmarks, with reproducibility commands + ROC plots.

Two real blockers:
1. **Datasets are gated** (Oxford VGG for VoxCeleb1, Edinburgh DataShare for ASVspoof). Operator must register + accept the licence + download.
2. **Scripts don't currently emit plots** (need matplotlib + sklearn to draw EER curves the supervisor can put in a slide deck).

What I CAN do without datasets: extend the scripts to emit ROC/DET plots + a per-utterance CSV for downstream analysis, harden the dataset-discovery code path, document the exact registration steps, and prep a slim `docs/paper/` folder for the plot artefacts.

What I CAN'T do without datasets: produce the actual EER numbers. That's the operator's run.

---

## Decisions to confirm before execution

| Topic | Default choice | Why |
|---|---|---|
| Datasets | ASVspoof 2019 LA eval split (~5 GB) + VoxCeleb1-O test pairs (~1 GB) | Standard published benchmarks; both used in the docs. |
| Plot toolkit | matplotlib + sklearn `roc_curve` | Industry standard; minimal new deps. |
| Output format | per-utterance CSV + summary JSON + EER/DET plot PNG | Exact format the supervisor can drop into a paper. |
| Threshold retune | Yes if measured EER threshold differs from current default by > 0.05 | Avoid changing config for a 0.01 drift; do change for a real miss. |
| New deps in CI | No — `[bench]` extra installed only on the operator's local box | Bench is a manual run, not CI. |

---

## Phase B1 — Dataset acquisition (operator action)

**Goal**: both eval datasets present on the local box.

### B1.1 — VoxCeleb1-O test pairs (~1 GB)

1. Register at <https://www.robots.ox.ac.uk/~vgg/data/voxceleb/voxceleb1.html>. Email approval is usually < 24 h.
2. Download `vox1_test_wav.zip` (~1 GB).
3. Download `veri_test2.txt` from the same page (cleaned trial pairs, 37,720 trials).
4. Unpack to a stable path, e.g. `~/data/voxceleb1/wav/` (preserving the `id*/{video_id}/{utt}.wav` directory tree).
5. Note the `veri_test2.txt` path and the `wav/` root.

### B1.2 — ASVspoof 2019 LA eval split (~5 GB)

1. Register at <https://datashare.ed.ac.uk/handle/10283/3336>. Accept the Edinburgh DataShare licence.
2. Download either `LA.zip` (full LA partition, ~16 GB) or just the eval split (~5 GB).
3. Unpack to `~/data/asvspoof2019_la/`.
4. Confirm protocol file at `ASVspoof2019_LA_cm_protocols/ASVspoof2019.LA.cm.eval.trl.txt`.
5. Confirm audio at `ASVspoof2019_LA_eval/flac/*.flac` (71,237 utterances).

### B1.3 — Smoke check

```bash
ls ~/data/voxceleb1/wav | head        # speaker dirs
wc -l ~/data/voxceleb1/veri_test2.txt # ~37720
ls ~/data/asvspoof2019_la/ASVspoof2019_LA_eval/flac | head
wc -l ~/data/asvspoof2019_la/ASVspoof2019_LA_cm_protocols/ASVspoof2019.LA.cm.eval.trl.txt
```

---

## Phase B2 — Extend bench scripts (matplotlib plotting + ROC/DET)

**Goal**: scripts produce paper-quality EER + DET curve PNGs alongside the existing JSON summary.

### B2.1 — New `[bench]` extra in `pyproject.toml`

```toml
bench = [
  "matplotlib>=3.8",
  "scikit-learn>=1.4",
]
```

Operator installs locally with `pip install -e ".[model,bench]"` before running. Out of CI scope.

### B2.2 — `backend/scripts/_plotting.py` (new shared helper)

- `plot_det_curve(scores, labels, output_path, title)` — DET curve via sklearn's `det_curve`. Standard log-prob axes that all the ASVspoof papers use.
- `plot_roc_curve(scores, labels, output_path, title)` — ROC + AUC.
- `plot_score_histogram(scores, labels, output_path, title)` — bonafide vs spoof distribution.

### B2.3 — Wire into both bench scripts

- `bench_eer_voxceleb.py` — add `--plot-dir` flag. After computing EER, save `det.png`, `roc.png`, `score_hist.png` to `<plot-dir>/voxceleb1_o/`.
- `bench_spoof_detection.py` — same. Save to `<plot-dir>/asvspoof2019_la/`.
- Both write a per-utterance CSV (`scores.csv` with columns `utt_id, score, label`) so downstream analysis isn't gated on the bench script.

### B2.4 — Output JSON shape (consistency)

Both scripts emit:
```json
{
  "dataset": "voxceleb1_o",
  "n_pairs": 37720,
  "eer": 0.0123,
  "eer_threshold": 0.71,
  "min_dcf_pt01": 0.087,
  "auc": 0.997,
  "wall_seconds": 612.5,
  "hardware": {"cpu": "Apple M2", "torch_device": "cpu"},
  "checkpoint_sha256": "...",
  "completed_at": "2026-05-11T..."
}
```

The `checkpoint_sha256` lets us prove the same weights produced the numbers later.

### B2.5 — Tests

- `backend/tests/test_bench_helpers.py` (new) — unit tests for `compute_eer`, `compute_min_dcf`, the new ROC/DET plot writers (assert files exist + are valid PNG).

---

## Phase B3 — Run the evals (operator triggers; I monitor)

### B3.1 — VoxCeleb1-O smoke first (~10 min)

```bash
cd backend
.venv/bin/python scripts/bench_eer_voxceleb.py \
  --pairs ~/data/voxceleb1/veri_test2.txt \
  --audio-root ~/data/voxceleb1/wav \
  --output docs/paper/results/voxceleb1_o.json \
  --plot-dir docs/paper/results/plots/ \
  --limit 1000   # smoke first
```

Verify output JSON + plot PNGs exist + EER lands in a sane range (1–10 %).

### B3.2 — VoxCeleb1-O full run (~25–40 min on M2)

Same command, drop `--limit`.

### B3.3 — ASVspoof 2019 LA smoke (~5 min)

```bash
.venv/bin/python scripts/bench_spoof_detection.py \
  --asvspoof-protocol ~/data/asvspoof2019_la/ASVspoof2019_LA_cm_protocols/ASVspoof2019.LA.cm.eval.trl.txt \
  --asvspoof-dir ~/data/asvspoof2019_la/ASVspoof2019_LA_eval/flac \
  --output docs/paper/results/asvspoof2019_la.json \
  --plot-dir docs/paper/results/plots/ \
  --limit 500
```

### B3.4 — ASVspoof 2019 LA full run (~30–60 min on M2)

Same, drop `--limit`. Capture wall time + log all-utterances throughput.

---

## Phase B4 — Threshold calibration

**Goal**: if the measured EER threshold differs significantly from the current `config.py` defaults (0.75 sim, 0.50 deepfake), retune.

- Read `eer_threshold` from each JSON output.
- If `|measured - default| > 0.05`, edit `backend/app/core/config.py`:
  - `similarity_threshold = <measured EER threshold from VoxCeleb run>`
  - `deepfake_threshold = <measured EER threshold from ASVspoof run>`
- If retuned, re-run `deploy/smoke.sh` to confirm the system still passes a self-verify.
- Document the chosen threshold + reasoning in `docs/thresholds.md` "Calibration history" section (new).
- Update the `Note: SDD convention, not calibrated` comment in `config.py` to "Calibrated against VoxCeleb1-O + ASVspoof 2019 LA on YYYY-MM-DD; see `docs/benchmarks.md`."

---

## Phase B5 — Update `docs/benchmarks.md`

**Goal**: every `_pending_` row in the Results tables is replaced with real numbers; plots are linked.

- Fill in:
  - `### VoxCeleb1-O` table: full eval + smoke rows with `EER`, `minDCF (P=0.01)`, `Threshold`, `Wall (CPU)`.
  - `### ASVspoof 2019 LA` table: full eval + smoke rows with `EER`, `EER threshold`, `Wall (CPU)`.
- Embed plots inline:
  ```markdown
  ![VoxCeleb1-O DET curve](paper/results/plots/voxceleb1_o/det.png)
  ![ASVspoof DET curve](paper/results/plots/asvspoof2019_la/det.png)
  ```
- Replace the "Self-contained smoke" row's caveat with the now-real eval numbers.
- Update the threshold cross-validation section with the actual EER threshold + the chosen production value.
- Mark `docs/remaining_work.md` G3 as ✅ done.

---

## Phase B6 — Release v1.0.2 (calibrated)

- CHANGELOG entry: "Real benchmark numbers landed; thresholds calibrated against VoxCeleb1-O + ASVspoof 2019 LA."
- `git tag -a v1.0.2 -m "..."` + push.
- Update `docs/audit-v1.0.md` verdict footer: "v1.0.2 closes the calibration gap (audit F-4) outright via measured EER thresholds."

---

## Critical files

### Backend
- `backend/pyproject.toml` — new `[bench]` extra (matplotlib + sklearn)
- `backend/scripts/_plotting.py` — new shared helper
- `backend/scripts/bench_eer_voxceleb.py` — `--plot-dir` + CSV output + checkpoint SHA + new JSON shape
- `backend/scripts/bench_spoof_detection.py` — same
- `backend/app/core/config.py` — recalibrated threshold defaults + updated docstring (Phase B4)
- `backend/tests/test_bench_helpers.py` — new

### Docs
- `Plan.md` — this file (B0)
- `docs/benchmarks.md` — Results tables filled in + plots embedded
- `docs/thresholds.md` — Calibration history section
- `docs/remaining_work.md` — mark G3 done
- `docs/audit-v1.0.md` — v1.0.2 footer
- `docs/paper/results/voxceleb1_o.json` — new
- `docs/paper/results/asvspoof2019_la.json` — new
- `docs/paper/results/plots/voxceleb1_o/{det,roc,score_hist}.png` — new
- `docs/paper/results/plots/asvspoof2019_la/{det,roc,score_hist}.png` — new
- `CHANGELOG.md` — v1.0.2 entry

### Ops
- `.gitignore` — `docs/paper/results/scores.csv` is fine to commit (small); raw FLAC stays local.

---

## Verification (run before tagging v1.0.2)

1. **Smoke runs land**: both `--limit 500/1000` runs produce JSONs with finite EER values (not NaN, not 0).
2. **Full runs land**: both unrestricted runs complete + JSONs land in `docs/paper/results/`.
3. **Plot files exist** + open in any image viewer (PNG, > 50 KB each).
4. **EER sanity**: VoxCeleb1-O EER < 5 % (ReDimNet B5 paper hits 0.79 %; expect us within an order of magnitude). ASVspoof EER < 10 %.
5. **Threshold check**: if defaults retuned, `deploy/smoke.sh` still passes (`SUBMIT VERIFICATION` returns ACCEPT on the operator's own voice).
6. **docs/benchmarks.md scan**: no `_pending_` rows left. Plot links resolve.
7. **`pytest -q -m "not slow"`** still 97/97 (no regression from the bench scripts).
8. **Tag**: `git tag v1.0.2` + push + GitHub release notes.

---

## Effort summary

| Phase | What | Engineer-days |
|---|---|---|
| B1 — Dataset acquisition | Registration + downloads (operator) | 0.5 (mostly waiting) |
| B2 — Extend bench scripts | Plot helpers + JSON shape + tests | 0.7 |
| B3 — Run evals | Smoke + full runs (mostly waiting on CPU) | 0.5 (1–2 h compute) |
| B4 — Threshold calibration | Read EER, retune if needed | 0.2 |
| B5 — Update docs/benchmarks.md | Tables + embedded plots | 0.3 |
| B6 — Release v1.0.2 | CHANGELOG + tag + push | 0.2 |
| **Total** | | **~2.4 engineer-days** (mostly compute-bound, not engineer-bound) |

Critical path: **B1 dataset acquisition** is the gating item. Everything after is mechanical. While B1 is waiting on Oxford VGG email approval, I execute B2 (script extensions) in parallel — that work is dataset-agnostic and lands plot helpers + new JSON shape ready for the eval run.

Out of scope (carried forward to v1.1):
- S2 (XTTS voice cloning).
- S7 (Tauri native installer).
- Trained sub-classifier heads (research-grade, gated by labelled training data).
