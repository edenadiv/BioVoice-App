"""F4 — sub-classifier (`AcousticProbe`) tests.

Covers the contract that the verification UI depends on:
  - Different audio shapes produce different per-axis scores (this is the
    explicit replacement for the seeded-jitter `_derive_analysis_details`
    that just perturbed the global deepfake score).
  - Heuristic mode is the default when no trained heads are bundled.
  - The probe handles empty / very short waveforms without crashing.
  - Verification pipeline surfaces the new derivation on the response.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.services.sub_classifier import AcousticProbe

from .conftest import make_wav


@pytest.fixture
def probe() -> AcousticProbe:
    return AcousticProbe(heads_path=None)


def _sine_wav_array(duration_s: float, frequency: float, amplitude: float = 0.6) -> list[float]:
    n = int(duration_s * 16000)
    return [amplitude * math.sin(2 * math.pi * frequency * i / 16000) for i in range(n)]


def _noise_wav_array(duration_s: float, seed: int = 1) -> list[float]:
    rng = np.random.RandomState(seed)
    return rng.uniform(-0.5, 0.5, int(duration_s * 16000)).tolist()


# -----------------------------------------------------------------------------
# The big one — different audio → different scores
# -----------------------------------------------------------------------------


def test_different_audio_produces_different_axes(probe: AcousticProbe):
    """The headline contract: this is what F4 is for. The previous
    `_derive_analysis_details` returned (s, s, s, 1-s) where s was the
    deepfake score — every recording had identical first three axes. The
    new probe must give axis-by-axis variation tied to actual audio
    properties."""
    sine = probe.score(_sine_wav_array(2.0, 220.0))
    noise = probe.score(_noise_wav_array(2.0))

    # Axes that differ:
    assert sine.voice_naturalness != noise.voice_naturalness
    assert sine.spectral_consistency != noise.spectral_consistency
    assert sine.artifact_detection != noise.artifact_detection
    # Sine has high HNR + voicing → high naturalness; noise has neither.
    assert sine.voice_naturalness > noise.voice_naturalness + 0.2
    # Noise has high spectral flatness → low consistency.
    assert sine.spectral_consistency > noise.spectral_consistency + 0.5


def test_axes_are_not_a_single_score_repeated(probe: AcousticProbe):
    """A clean sine should NOT have all four axes identical (the old
    derivation had three axes equal to deepfake_score). The probe's
    heuristic combinations guarantee at least two axes differ."""
    result = probe.score(_sine_wav_array(2.0, 220.0))
    values = [
        result.voice_naturalness,
        result.spectral_consistency,
        result.temporal_patterns,
        result.artifact_detection,
    ]
    distinct = {round(v, 3) for v in values}
    assert len(distinct) >= 3, f"Expected variation across axes, got {values}"


# -----------------------------------------------------------------------------
# Per-axis sanity
# -----------------------------------------------------------------------------


def test_voice_naturalness_high_for_harmonic_low_for_noise(probe: AcousticProbe):
    sine = probe.score(_sine_wav_array(2.0, 220.0))
    noise = probe.score(_noise_wav_array(2.0))
    assert sine.voice_naturalness > 0.5
    assert noise.voice_naturalness < 0.2


def test_spectral_consistency_high_for_tonal_low_for_broadband(probe: AcousticProbe):
    sine = probe.score(_sine_wav_array(2.0, 220.0))
    noise = probe.score(_noise_wav_array(2.0))
    assert sine.spectral_consistency > 0.9
    assert noise.spectral_consistency < 0.2


def test_artifact_detection_inverse_of_synthetic_artifacts(probe: AcousticProbe):
    sine = probe.score(_sine_wav_array(2.0, 220.0))
    noise = probe.score(_noise_wav_array(2.0))
    # Sine = clean → high artifact detection (no artifacts found).
    # Noise = high spectral flatness + zero HNR → low artifact detection.
    assert sine.artifact_detection > noise.artifact_detection


# -----------------------------------------------------------------------------
# Edge cases
# -----------------------------------------------------------------------------


def test_empty_waveform_returns_zeroish_axes(probe: AcousticProbe):
    result = probe.score([])
    # Don't crash; bounded values.
    assert 0.0 <= result.voice_naturalness <= 1.0
    assert 0.0 <= result.spectral_consistency <= 1.0
    assert 0.0 <= result.temporal_patterns <= 1.0
    assert 0.0 <= result.artifact_detection <= 1.0


def test_very_short_waveform_returns_bounded_axes(probe: AcousticProbe):
    result = probe.score([0.0] * 100)
    assert 0.0 <= result.voice_naturalness <= 1.0


def test_missing_heads_file_falls_back_to_heuristic(tmp_path):
    """If the operator points at a non-existent heads file, the probe
    silently falls back to heuristic mode rather than crashing the
    verification pipeline."""
    probe = AcousticProbe(heads_path=tmp_path / "definitely_not_there.pt")
    result = probe.score(_sine_wav_array(2.0, 220.0))
    assert result.voice_naturalness > 0.0


# -----------------------------------------------------------------------------
# Pipeline integration
# -----------------------------------------------------------------------------


def test_verify_uses_acoustic_probe_for_analysis_details(
    verification_service, enrolled_user, detector
):
    """The verification response now carries probe-derived axes. Two
    different verification audios should produce different per-axis
    AnalysisDetails."""
    user_id, enrolled_wav = enrolled_user
    detector.score = 0.9

    sine_220 = verification_service.verify(user_id=user_id, audio_bytes=enrolled_wav)
    sine_440 = verification_service.verify(
        user_id=user_id, audio_bytes=make_wav(2.0, frequency=440.0)
    )
    assert sine_220.analysis_details is not None
    assert sine_440.analysis_details is not None

    # Different inputs → at least one axis differs (smaller threshold here
    # because both inputs are tonal sines — they'll be similar).
    diff = abs(sine_220.analysis_details.voice_naturalness - sine_440.analysis_details.voice_naturalness)
    diff += abs(sine_220.analysis_details.spectral_consistency - sine_440.analysis_details.spectral_consistency)
    diff += abs(sine_220.analysis_details.temporal_patterns - sine_440.analysis_details.temporal_patterns)
    diff += abs(sine_220.analysis_details.artifact_detection - sine_440.analysis_details.artifact_detection)
    assert diff > 0.0, "Probe should produce input-dependent axes"
