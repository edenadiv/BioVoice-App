"""Suggest the EER-optimal `deepfake_threshold` from a benchmark run.

Reads either:
  * a per-utterance scores CSV written by `bench_spoof_detection.py
    --plot-dir` (columns: utt_id, score, label), or
  * a bench JSON (uses its `eer_threshold` field directly).

and prints the suggested `Settings.deepfake_threshold` — the AASIST score
at the EER operating point (decision GENUINE when score >= threshold).
Persist it via `backend/.env` (`DEEPFAKE_THRESHOLD=...`) or live via
`PATCH /config {"deepfake_threshold": ...}`.

Usage:
    cd backend
    .venv/bin/python scripts/calibrate_thresholds.py --scores-csv reports/spoof/scores.csv
    .venv/bin/python scripts/calibrate_thresholds.py --bench-json reports/spoof/summary.json
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import sys
from pathlib import Path

import numpy as np

THIS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(THIS_DIR))

from bench_spoof_detection import compute_eer  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("calibrate_thresholds")


def from_csv(path: Path) -> tuple[float, float]:
    scores: list[float] = []
    labels: list[int] = []
    with path.open() as f:
        reader = csv.DictReader(f)
        fields = {(k or "").lower(): k for k in (reader.fieldnames or [])}
        score_key = fields.get("score")
        label_key = fields.get("label")
        if score_key is None or label_key is None:
            raise SystemExit(
                f"{path}: expected 'score' and 'label' columns, got {reader.fieldnames}"
            )
        for row in reader:
            scores.append(float(row[score_key]))
            labels.append(int(float(row[label_key])))
    if not scores:
        raise SystemExit(f"{path}: no rows")
    return compute_eer(
        np.asarray(scores, dtype=np.float32), np.asarray(labels, dtype=np.int32)
    )


def from_bench_json(path: Path, dataset_name: str | None) -> tuple[float, float]:
    data = json.loads(path.read_text())
    key = dataset_name or data.get("dataset")
    summary = data.get(key, {}) if key else {}
    if "eer_threshold" not in summary:
        raise SystemExit(f"{path}: no eer_threshold under dataset '{key}'")
    return float(summary.get("eer", float("nan"))), float(summary["eer_threshold"])


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--scores-csv", type=Path)
    src.add_argument("--bench-json", type=Path)
    parser.add_argument(
        "--dataset-name", type=str, default=None,
        help="When reading a bench JSON, the dataset key holding the summary "
             "(defaults to the JSON's own 'dataset').",
    )
    parser.add_argument(
        "--emit-env", action="store_true",
        help="Also print a DEEPFAKE_THRESHOLD=<t> line for backend/.env.",
    )
    args = parser.parse_args()

    if args.scores_csv is not None:
        eer, threshold = from_csv(args.scores_csv)
    else:
        eer, threshold = from_bench_json(args.bench_json, args.dataset_name)

    logger.info("EER = %.4f   suggested deepfake_threshold = %.4f", eer, threshold)
    if args.emit_env:
        print(f"DEEPFAKE_THRESHOLD={threshold:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
