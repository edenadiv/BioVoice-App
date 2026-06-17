"""ClusterEnsembleDetectorService — metadata parsing and heuristic fallback.

Mirrors test_detector.py's hermetic style: no real ECAPA/torch model load is
required for the core assertions. A gated test exercises the full pipeline
when speechbrain/torch and the real cluster artifacts are present.
"""

from __future__ import annotations

import pytest

from app.services.cluster_detector import ClusterEnsembleDetectorService
from app.services.ensemble_detector import _heuristic_score


def test_load_cluster_metadata_from_csv_and_members():
    from app.core.config import settings

    if not settings.cluster_models_path.exists():
        pytest.skip("cluster model artifacts not present")

    detector = ClusterEnsembleDetectorService(models_path=settings.cluster_models_path)
    meta = detector._load_cluster_metadata()

    assert set(meta.keys()) == {1, 2, 3, 4, 5, 6, 7}
    assert meta[1].members == ["A12", "A19"]
    assert meta[1].label == "Concatenative / Unit-selection"
    assert meta[7].members == ["A28"]
    assert "Pretrained" in meta[7].label


def test_provenance_is_heuristic_without_models(tmp_path):
    detector = ClusterEnsembleDetectorService(models_path=tmp_path)
    assert detector.provenance == "heuristic"
    assert detector.last_top_cluster is None


def test_detect_falls_back_to_heuristic_score(tmp_path):
    detector = ClusterEnsembleDetectorService(models_path=tmp_path)
    waveform = [0.1, -0.05, 0.2, -0.1] * 100
    assert detector.detect(waveform) == pytest.approx(_heuristic_score(waveform))
    assert detector.last_top_cluster is None


def test_real_cluster_ensemble_detect():
    from app.core.config import settings

    pytest.importorskip("speechbrain")
    pytest.importorskip("torch")
    if not settings.cluster_models_path.exists():
        pytest.skip("cluster model artifacts not present")

    detector = ClusterEnsembleDetectorService(
        models_path=settings.cluster_models_path,
        ecapa_savedir=settings.ecapa_savedir,
    )
    if detector.provenance != "ecapa_cluster_ensemble":
        pytest.skip("ECAPA encoder/cluster classifiers failed to load")

    waveform = [0.1, -0.05, 0.2, -0.1] * 4000
    detector.detect(waveform)

    assert detector.last_total == 7
    assert detector.last_top_cluster is not None
    assert detector.last_top_cluster.cluster_id in range(1, 8)
    assert isinstance(detector.last_top_cluster.label, str) and detector.last_top_cluster.label
