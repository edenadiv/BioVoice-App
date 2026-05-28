"""Trained-heads path for the AcousticProbe sub-classifier.

Trains the four MLP heads on the committed demo manifest, saves them, and
asserts the runtime loads them and reports provenance "trained_heads".
Marked `slow` because it imports torch and runs a (tiny) training loop.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT / "scripts"))

FIXTURE = BACKEND_ROOT / "tests" / "fixtures" / "sub_classifier_demo_manifest.csv"


@pytest.mark.slow
def test_trained_heads_load_and_score(tmp_path: Path):
    import torch

    from train_sub_classifier import AXIS_NAMES, load_manifest, train_axis
    from app.services.acoustic_features import FEATURE_DIM
    from app.services.sub_classifier import AcousticProbe

    X, Y = load_manifest(FIXTURE)
    assert X.shape == (6, FEATURE_DIM)

    n_val = 1
    state: dict = {}
    for j, name in enumerate(AXIS_NAMES):
        head, _ = train_axis(
            name, X[n_val:], Y[n_val:, j], X[:n_val], Y[:n_val, j], epochs=3
        )
        state[name] = {"fc1": head.fc1.state_dict(), "fc2": head.fc2.state_dict()}

    out = tmp_path / "aasist_heads.pt"
    torch.save(state, out)

    probe = AcousticProbe(heads_path=out)
    probe._ensure_loaded()
    assert probe.provenance == "trained_heads"

    details = probe.score([0.1] * 16000)
    assert details.mode == "trained_heads"
    for value in (
        details.voice_naturalness,
        details.spectral_consistency,
        details.temporal_patterns,
        details.artifact_detection,
    ):
        assert 0.0 <= value <= 1.0


def test_heuristic_fallback_when_heads_absent(tmp_path: Path):
    """No heads file -> heuristic mode (no torch needed)."""
    from app.services.sub_classifier import AcousticProbe

    probe = AcousticProbe(heads_path=tmp_path / "does_not_exist.pt")
    probe._ensure_loaded()
    assert probe.provenance == "heuristic"
    assert probe.score([0.1] * 16000).mode == "heuristic"
