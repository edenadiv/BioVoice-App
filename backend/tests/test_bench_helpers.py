"""B2 — unit tests for the benchmark plotting + math helpers.

Skipped when the [bench] extras (matplotlib + sklearn) aren't installed.
Verifies the plot writers actually emit valid PNG files (magic bytes)
and that the EER / minDCF math is sane on a hand-crafted score set."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest


_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND / "scripts"))


_HAS_PLOT_DEPS: bool
try:
    import matplotlib  # noqa: F401
    import sklearn  # noqa: F401
    _HAS_PLOT_DEPS = True
except ImportError:
    _HAS_PLOT_DEPS = False


_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


@pytest.mark.skipif(not _HAS_PLOT_DEPS, reason="[bench] extras (matplotlib + sklearn) not installed")
def test_plot_det_curve_writes_valid_png(tmp_path: Path):
    from _plotting import plot_det_curve
    rng = np.random.default_rng(seed=42)
    scores = np.concatenate([rng.normal(0.8, 0.1, 200), rng.normal(0.3, 0.15, 200)])
    labels = np.concatenate([np.ones(200), np.zeros(200)]).astype(np.int32)
    out = plot_det_curve(scores, labels, tmp_path / "det.png", title="test")
    assert out.exists()
    assert out.stat().st_size > 10_000, "DET PNG should be > 10 KB"
    assert out.read_bytes()[:8] == _PNG_MAGIC


@pytest.mark.skipif(not _HAS_PLOT_DEPS, reason="[bench] extras not installed")
def test_plot_roc_curve_writes_valid_png(tmp_path: Path):
    from _plotting import plot_roc_curve
    rng = np.random.default_rng(seed=42)
    scores = np.concatenate([rng.normal(0.8, 0.1, 100), rng.normal(0.2, 0.1, 100)])
    labels = np.concatenate([np.ones(100), np.zeros(100)]).astype(np.int32)
    out = plot_roc_curve(scores, labels, tmp_path / "roc.png", title="test")
    assert out.exists()
    assert out.read_bytes()[:8] == _PNG_MAGIC


@pytest.mark.skipif(not _HAS_PLOT_DEPS, reason="[bench] extras not installed")
def test_plot_score_histogram_writes_valid_png(tmp_path: Path):
    from _plotting import plot_score_histogram
    rng = np.random.default_rng(seed=42)
    scores = np.concatenate([rng.normal(0.7, 0.1, 50), rng.normal(0.3, 0.1, 50)])
    labels = np.concatenate([np.ones(50), np.zeros(50)]).astype(np.int32)
    out = plot_score_histogram(scores, labels, tmp_path / "hist.png", title="test")
    assert out.exists()
    assert out.read_bytes()[:8] == _PNG_MAGIC


def test_write_score_csv_shape(tmp_path: Path):
    """write_score_csv only needs Python's csv module — works with or
    without the [bench] extras."""
    from _plotting import write_score_csv
    out = write_score_csv(
        tmp_path / "scores.csv",
        [("utt_a", 0.91, 1), ("utt_b", 0.13, 0), ("utt_c", 0.55, 1)],
    )
    lines = out.read_text().strip().splitlines()
    assert lines[0] == "utt_id,score,label"
    assert lines[1].startswith("utt_a,")
    assert "0.910000" in lines[1] or "0.91" in lines[1]
    assert len(lines) == 4  # header + 3 rows


def test_compute_eer_perfect_separation():
    """If all bonafide scores > all spoof scores, EER should be 0."""
    sys.path.insert(0, str(_BACKEND / "scripts"))
    from bench_eer_voxceleb import compute_eer
    scores = np.array([0.9, 0.85, 0.8, 0.2, 0.1, 0.05], dtype=np.float32)
    labels = np.array([1, 1, 1, 0, 0, 0], dtype=np.int32)
    eer, threshold = compute_eer(scores, labels)
    assert eer == pytest.approx(0.0, abs=0.01)


def test_compute_eer_random_scores_around_50pct():
    """Random scores → EER near 50 % (chance)."""
    sys.path.insert(0, str(_BACKEND / "scripts"))
    from bench_eer_voxceleb import compute_eer
    rng = np.random.default_rng(seed=1)
    scores = rng.random(2000).astype(np.float32)
    labels = (rng.random(2000) > 0.5).astype(np.int32)
    eer, _ = compute_eer(scores, labels)
    assert 0.40 < eer < 0.60, f"random scores should give EER ~ 0.5, got {eer}"


def test_compute_min_dcf_finite():
    """minDCF on a non-degenerate score set should return a finite number."""
    sys.path.insert(0, str(_BACKEND / "scripts"))
    from bench_eer_voxceleb import compute_min_dcf
    rng = np.random.default_rng(seed=2)
    scores = np.concatenate([rng.normal(0.7, 0.1, 100), rng.normal(0.3, 0.1, 100)]).astype(np.float32)
    labels = np.concatenate([np.ones(100), np.zeros(100)]).astype(np.int32)
    min_dcf = compute_min_dcf(scores, labels, p_target=0.01)
    assert np.isfinite(min_dcf)
    assert 0.0 <= min_dcf <= 1.0
