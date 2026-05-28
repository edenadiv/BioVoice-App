"""Tests for scripts/calibrate_thresholds.py — EER-optimal deepfake_threshold
selection from a scores CSV or a bench JSON."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT / "scripts"))

from calibrate_thresholds import from_bench_json, from_csv  # noqa: E402


def test_from_csv_perfect_separation(tmp_path: Path):
    p = tmp_path / "scores.csv"
    p.write_text("utt_id,score,label\ng1,0.9,1\ng2,0.85,1\ns1,0.2,0\ns2,0.3,0\n")
    eer, threshold = from_csv(p)
    assert eer == 0.0
    # threshold lands between the spoof max (0.3) and genuine min (0.85)
    assert 0.3 <= threshold <= 0.9


def test_from_csv_missing_columns(tmp_path: Path):
    p = tmp_path / "bad.csv"
    p.write_text("utt_id,foo\ng1,0.9\n")
    with pytest.raises(SystemExit):
        from_csv(p)


def test_from_bench_json(tmp_path: Path):
    p = tmp_path / "summary.json"
    p.write_text(json.dumps({"dataset": "spoof_x", "spoof_x": {"eer": 0.05, "eer_threshold": 0.62}}))
    eer, threshold = from_bench_json(p, None)
    assert eer == pytest.approx(0.05)
    assert threshold == pytest.approx(0.62)


def test_from_bench_json_missing_threshold(tmp_path: Path):
    p = tmp_path / "summary.json"
    p.write_text(json.dumps({"dataset": "spoof_x", "spoof_x": {"eer": 0.05}}))
    with pytest.raises(SystemExit):
        from_bench_json(p, None)
