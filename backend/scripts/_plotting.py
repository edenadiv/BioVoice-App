"""B2 — shared plotting helpers for the benchmark scripts.

Three functions that all the bench scripts call to emit paper-quality
plots into a `--plot-dir` argument:

  - plot_det_curve(scores, labels, output_path, title)
        DET (Detection Error Tradeoff) curve via sklearn's det_curve.
        The standard log-prob axes used in every ASVspoof paper.
  - plot_roc_curve(scores, labels, output_path, title)
        ROC + AUC. Quick sanity-check plot.
  - plot_score_histogram(scores, labels, output_path, title)
        Bonafide vs spoof score distribution. Tells you at a glance
        whether the two classes are separable.

All three:
  - Take 1-D numpy arrays of scores (higher = more genuine) + binary
    labels (1 = bonafide / target speaker, 0 = spoof / impostor).
  - Write a 1200 × 900 DPI=120 PNG to the supplied path.
  - Use matplotlib's Agg backend so they work headlessly (no DISPLAY).
  - Are dependency-isolated to the [bench] extra — fail loud with
    actionable install instructions if matplotlib / sklearn missing.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

try:
    import matplotlib
    matplotlib.use("Agg")  # headless / CI-friendly
    import matplotlib.pyplot as plt
    from sklearn.metrics import det_curve, roc_curve, auc
except ImportError as exc:  # pragma: no cover — operator-facing message
    raise ImportError(
        "Bench plotting requires matplotlib + scikit-learn. "
        "Install the [bench] extra:\n"
        "    pip install -e \".[model,bench]\"\n"
        f"(original error: {exc})"
    ) from exc


_FIGSIZE = (10, 7.5)  # 1200 × 900 at dpi=120
_DPI = 120


def _ensure_parent(path: Path) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def plot_det_curve(
    scores: np.ndarray,
    labels: np.ndarray,
    output_path: Path,
    title: str,
) -> Path:
    """Standard DET plot. X = false acceptance rate (FAR), Y = false
    rejection rate (FRR), both in normal-deviate / log-prob axes — the
    convention every ASVspoof paper uses."""
    output_path = _ensure_parent(output_path)
    fpr, fnr, _ = det_curve(labels, scores)

    fig, ax = plt.subplots(figsize=_FIGSIZE, dpi=_DPI)
    ax.plot(fpr * 100, fnr * 100, lw=2, color="#1f77b4")

    # EER reference: where FAR ≈ FRR
    eer_idx = int(np.argmin(np.abs(fpr - fnr)))
    eer_pct = (fpr[eer_idx] + fnr[eer_idx]) / 2.0 * 100.0
    ax.plot([0.001, 100], [0.001, 100], lw=1, color="#bbbbbb", linestyle="--", alpha=0.6, label="EER line (FAR = FRR)")
    ax.scatter([fpr[eer_idx] * 100], [fnr[eer_idx] * 100], s=80, color="#d62728", zorder=5, label=f"EER point ({eer_pct:.2f}%)")

    ax.set_xlabel("False Acceptance Rate (%)", fontsize=12)
    ax.set_ylabel("False Rejection Rate (%)", fontsize=12)
    ax.set_title(title, fontsize=14)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlim(0.05, 60)
    ax.set_ylim(0.05, 60)
    ax.grid(True, which="both", linestyle=":", alpha=0.5)
    ax.legend(loc="upper right", fontsize=10)

    fig.tight_layout()
    fig.savefig(output_path, dpi=_DPI, bbox_inches="tight")
    plt.close(fig)
    return output_path


def plot_roc_curve(
    scores: np.ndarray,
    labels: np.ndarray,
    output_path: Path,
    title: str,
) -> Path:
    """ROC + AUC. Sanity-check plot showing the trade-off curve."""
    output_path = _ensure_parent(output_path)
    fpr, tpr, _ = roc_curve(labels, scores)
    auc_value = auc(fpr, tpr)

    fig, ax = plt.subplots(figsize=_FIGSIZE, dpi=_DPI)
    ax.plot(fpr * 100, tpr * 100, lw=2, color="#2ca02c", label=f"AUC = {auc_value:.4f}")
    ax.plot([0, 100], [0, 100], lw=1, color="#bbbbbb", linestyle="--", alpha=0.6, label="Chance")

    ax.set_xlabel("False Positive Rate (%)", fontsize=12)
    ax.set_ylabel("True Positive Rate (%)", fontsize=12)
    ax.set_title(title, fontsize=14)
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 100)
    ax.grid(True, linestyle=":", alpha=0.5)
    ax.legend(loc="lower right", fontsize=11)

    fig.tight_layout()
    fig.savefig(output_path, dpi=_DPI, bbox_inches="tight")
    plt.close(fig)
    return output_path


def plot_score_histogram(
    scores: np.ndarray,
    labels: np.ndarray,
    output_path: Path,
    title: str,
) -> Path:
    """Score distribution per class. Visual sanity check — if the two
    histograms overlap heavily, the model isn't separating the classes."""
    output_path = _ensure_parent(output_path)
    bonafide = scores[labels == 1]
    spoof = scores[labels == 0]

    fig, ax = plt.subplots(figsize=_FIGSIZE, dpi=_DPI)
    bins = 60
    ax.hist(spoof, bins=bins, alpha=0.55, color="#d62728", label=f"Spoof / impostor (n={len(spoof)})")
    ax.hist(bonafide, bins=bins, alpha=0.55, color="#2ca02c", label=f"Bonafide / target (n={len(bonafide)})")

    ax.set_xlabel("Score (higher = more genuine)", fontsize=12)
    ax.set_ylabel("Count", fontsize=12)
    ax.set_title(title, fontsize=14)
    ax.grid(True, axis="y", linestyle=":", alpha=0.5)
    ax.legend(loc="upper center", fontsize=11)

    fig.tight_layout()
    fig.savefig(output_path, dpi=_DPI, bbox_inches="tight")
    plt.close(fig)
    return output_path


def write_score_csv(
    output_path: Path,
    rows: list[tuple[str, float, int]],
) -> Path:
    """Write per-utterance scores to CSV: utt_id, score, label.

    `rows` is `(utt_id: str, score: float, label: int)` tuples. The
    operator (or downstream analysis) can re-derive any metric from this
    file without re-running the bench script."""
    import csv
    output_path = _ensure_parent(output_path)
    with output_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["utt_id", "score", "label"])
        for utt_id, score, label in rows:
            writer.writerow([utt_id, f"{score:.6f}", int(label)])
    return output_path
