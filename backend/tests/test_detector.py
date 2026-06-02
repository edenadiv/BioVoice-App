"""DeepfakeDetectorService preprocessing guards.

Regression: `_prepare_waveform` once scaled every input to a 0.05 peak
(~26 dB too quiet), pushing AASIST off its training distribution so it
returned a near-constant "bonafide ≈ 0.99" for everything — silently
disabling spoof detection across `/verify` and `/spoof/test`. The model
correctly flags clones only when fed at natural (near-full-scale)
amplitude, so the normalisation target must stay near 1.0.
"""

from __future__ import annotations

import pytest

from app.services.detector import DeepfakeDetectorService


def _detector() -> DeepfakeDetectorService:
    # load() wires up torch even when no weights are present, which is all
    # _prepare_waveform needs. Keeps the test hermetic (no AASIST weights).
    detector = DeepfakeDetectorService(weights_path=None)
    detector.load()
    if detector._torch is None:
        pytest.skip("torch unavailable")
    return detector


def test_prepare_waveform_normalizes_near_full_scale():
    detector = _detector()
    # A quiet input (peak 0.2) must be brought UP to ~full scale, not left
    # quiet and never scaled down to the old 0.05 regression value.
    tensor = detector._prepare_waveform([0.2, -0.15, 0.1, -0.2] * 500)
    peak = float(tensor.abs().max())
    assert peak == pytest.approx(detector._target_peak, abs=0.02)
    assert peak > 0.5, "regression: inputs scaled too quiet for AASIST"


def test_target_peak_is_near_full_scale():
    # Direct guard on the constant so the 0.05 regression can't reappear.
    assert DeepfakeDetectorService()._target_peak >= 0.5
