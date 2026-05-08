"""F3.3 — sample quality scoring tests.

Covers:
  - Clean fixture (uniform 220 Hz sine) → score ≥ 70, acceptable.
  - Heavy clipping (saturated PCM) → rejected with the clipping message.
  - Low SNR (speech buried in louder noise) → rejected with the SNR message.
  - Mostly silence with brief speech → rejected with the speech-ratio message.
  - Quality is surfaced on EnrollmentResponse.quality.
"""

from __future__ import annotations

import math
from io import BytesIO
import wave

import pytest

from app.services.audio import (
    AudioService,
    QUALITY_MIN_SNR_DB,
    QUALITY_MAX_CLIPPING_PCT,
    QUALITY_MIN_SPEECH_RATIO,
    SampleQualityRejectedError,
)

from .conftest import SAMPLE_RATE, make_wav


def _saturated_wav(duration_s: float) -> bytes:
    """Hard-clipped square wave that pegs ±32767 for runs >> 3 samples."""
    n = int(duration_s * SAMPLE_RATE)
    payload = bytearray()
    pulse = 200  # samples per polarity flip → long plateaus
    for i in range(n):
        value = 32767 if (i // pulse) % 2 == 0 else -32767
        payload += value.to_bytes(2, "little", signed=True)
    buffer = BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(bytes(payload))
    return buffer.getvalue()


def _noisy_speech_wav(duration_s: float, signal_amp: float, noise_amp: float, seed: int = 1) -> bytes:
    """A 220 Hz tone (the "speech" stand-in) embedded in additive Gaussian
    noise. SNR controllable via the two amplitudes."""
    import random

    rng = random.Random(seed)
    n = int(duration_s * SAMPLE_RATE)
    payload = bytearray()
    for i in range(n):
        signal = signal_amp * math.sin(2 * math.pi * 220.0 * i / SAMPLE_RATE)
        noise = noise_amp * (rng.random() * 2 - 1)
        # Clamp into int16 range — for a noisy mix this won't usually clip
        # because we keep amplitudes well below 1.0.
        sample = max(-1.0, min(1.0, signal + noise))
        value = int(sample * 32767)
        payload += value.to_bytes(2, "little", signed=True)
    buffer = BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(bytes(payload))
    return buffer.getvalue()


def _brief_speech_wav(silent_before_s: float, speech_s: float, silent_after_s: float) -> bytes:
    n_pre = int(silent_before_s * SAMPLE_RATE)
    n_post = int(silent_after_s * SAMPLE_RATE)
    n_speech = int(speech_s * SAMPLE_RATE)
    payload = bytearray(b"\x00\x00" * n_pre)
    for i in range(n_speech):
        value = int(0.6 * 32767 * math.sin(2 * math.pi * 220.0 * i / SAMPLE_RATE))
        payload += value.to_bytes(2, "little", signed=True)
    payload += b"\x00\x00" * n_post
    buffer = BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(bytes(payload))
    return buffer.getvalue()


@pytest.fixture
def audio_service() -> AudioService:
    return AudioService(target_sample_rate=SAMPLE_RATE)


# -----------------------------------------------------------------------------
# Clean signal — passes the gate
# -----------------------------------------------------------------------------


def test_clean_recording_scores_above_70(audio_service: AudioService):
    payload = audio_service.decode_wav(make_wav(2.0, frequency=220.0))
    score = audio_service.score_quality(payload)
    assert score.acceptable
    assert score.reason == ""
    assert score.score >= 70.0
    assert score.snr_db >= QUALITY_MIN_SNR_DB
    assert score.clipping_pct <= QUALITY_MAX_CLIPPING_PCT
    assert score.speech_ratio >= QUALITY_MIN_SPEECH_RATIO


# -----------------------------------------------------------------------------
# Clipping
# -----------------------------------------------------------------------------


def test_saturated_recording_is_rejected_for_clipping(audio_service: AudioService):
    payload = audio_service.decode_wav(_saturated_wav(2.0))
    score = audio_service.score_quality(payload)
    assert not score.acceptable
    assert "clipped" in score.reason
    assert score.clipping_pct > QUALITY_MAX_CLIPPING_PCT


# -----------------------------------------------------------------------------
# SNR
# -----------------------------------------------------------------------------


def test_low_snr_recording_is_rejected(audio_service: AudioService):
    """signal_amp 0.05 vs noise_amp 0.4 → tone buried under noise. The
    noise-floor estimator should pick up the noise as the floor and find
    only a tiny SNR margin."""
    payload = audio_service.decode_wav(_noisy_speech_wav(2.0, signal_amp=0.05, noise_amp=0.4))
    score = audio_service.score_quality(payload)
    # We only require the SNR check to fire — it's the dominant failure
    # mode for this signal. The other metrics may also flag (uniform
    # noise has high speech ratio etc.); that's fine.
    assert not score.acceptable
    assert "SNR" in score.reason


# -----------------------------------------------------------------------------
# Speech ratio
# -----------------------------------------------------------------------------


def test_low_speech_ratio_recording_is_rejected(audio_service: AudioService):
    """Most of the recording is silence, with a brief 0.5 s burst of
    speech. The VAD-derived speech_ratio is well below the 0.30 floor."""
    payload = audio_service.decode_wav(_brief_speech_wav(2.0, 0.5, 2.0))
    score = audio_service.score_quality(payload)
    assert not score.acceptable
    assert "speech" in score.reason
    assert score.speech_ratio < QUALITY_MIN_SPEECH_RATIO


# -----------------------------------------------------------------------------
# Pipeline integration — EnrollmentResponse carries quality
# -----------------------------------------------------------------------------


def test_enrollment_response_carries_quality(verification_service):
    response = verification_service.enroll(
        user_id="quality_test",
        audio_bytes=make_wav(2.0, frequency=220.0),
        filename="ok.wav",
    )
    assert response.quality is not None
    assert response.quality.acceptable
    assert response.quality.score >= 70.0


def test_enroll_rejects_clipped_sample(verification_service):
    with pytest.raises(SampleQualityRejectedError) as exc:
        verification_service.enroll(
            user_id="bad", audio_bytes=_saturated_wav(2.0), filename="bad.wav"
        )
    assert "clipped" in str(exc.value)
    # The exception carries the QualityScore for any caller that wants
    # the per-axis breakdown (the kiosk Enroll screen renders it).
    assert exc.value.score.clipping_pct > QUALITY_MAX_CLIPPING_PCT
