"""F3.2 — Voice Activity Detection tests.

Covers:
  - Silent waveform → no regions, trim_to_voice raises.
  - Padded waveform (leading/trailing silence around speech) → trimmed to
    the speech region with ~80 ms padding either side.
  - Pure-tone waveform (test fixture shape) → entire signal kept (uniform
    energy → adaptive threshold falls back to absolute).
  - Sub-1 s of speech after trim → raises ValueError so the route layer
    can map to 400.
  - Verification pipeline propagates the VAD failure as ValueError ⇒
    fixture chooses to verify whether a silent recording is rejected
    before the encoder runs.
"""

from __future__ import annotations

import math
from io import BytesIO
import wave

import pytest

from app.services.audio import (
    AudioService,
    MIN_SPEECH_SECONDS,
    VAD_PAD_MS,
)

from .conftest import HashEncoder, SAMPLE_RATE, StubDetector, make_wav


def _silence_wav(duration_s: float) -> bytes:
    """All-zero PCM at the test sample rate."""
    n = int(duration_s * SAMPLE_RATE)
    buffer = BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(b"\x00\x00" * n)
    return buffer.getvalue()


def _padded_wav(silence_before_s: float, speech_s: float, silence_after_s: float) -> bytes:
    """Silence + 220 Hz sine + silence stitched into one WAV."""
    pre = int(silence_before_s * SAMPLE_RATE)
    post = int(silence_after_s * SAMPLE_RATE)
    speech_n = int(speech_s * SAMPLE_RATE)
    payload = bytearray(b"\x00\x00" * pre)
    for i in range(speech_n):
        value = int(0.6 * 32767 * math.sin(2 * math.pi * 220.0 * i / SAMPLE_RATE))
        payload += value.to_bytes(2, "little", signed=True)
    payload += b"\x00\x00" * post
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
# detect_voice_activity — direct tests
# -----------------------------------------------------------------------------


def test_silence_yields_no_regions(audio_service: AudioService):
    payload = audio_service.decode_wav(_silence_wav(2.0))
    result = audio_service.detect_voice_activity(payload.waveform, payload.sample_rate)
    assert result.regions == []
    assert result.voiced_seconds == 0.0


def test_padded_speech_is_trimmed_to_voice_region(audio_service: AudioService):
    payload = audio_service.decode_wav(_padded_wav(0.5, 1.5, 0.5))
    result = audio_service.detect_voice_activity(payload.waveform, payload.sample_rate)
    assert len(result.regions) >= 1
    # First region should start in the leading-silence band but no later than
    # the actual speech onset (allowing the configured pre-pad).
    speech_start_sample = int(0.5 * SAMPLE_RATE)
    pad_samples = int(SAMPLE_RATE * VAD_PAD_MS / 1000)
    assert result.regions[0][0] <= speech_start_sample
    assert result.regions[0][0] >= speech_start_sample - pad_samples * 2
    # Last region should end inside the trailing-silence band.
    speech_end_sample = int(2.0 * SAMPLE_RATE)
    assert result.regions[-1][1] >= speech_end_sample - pad_samples
    assert result.regions[-1][1] <= speech_end_sample + pad_samples * 2


def test_uniform_pure_tone_keeps_entire_signal(audio_service: AudioService):
    """Synthetic test fixtures produce uniform-energy signals. The adaptive
    threshold must classify them as one continuous speech region rather
    than collapsing to silence (which would break every existing
    verification test that uses make_wav)."""
    payload = audio_service.decode_wav(make_wav(2.0, frequency=220.0))
    result = audio_service.detect_voice_activity(payload.waveform, payload.sample_rate)
    assert len(result.regions) == 1
    start, end = result.regions[0]
    assert start == 0
    # Padding clamps the end to the signal length.
    assert end == len(payload.waveform)


# -----------------------------------------------------------------------------
# trim_to_voice — pipeline-facing helper
# -----------------------------------------------------------------------------


def test_trim_silence_raises(audio_service: AudioService):
    payload = audio_service.decode_wav(_silence_wav(2.0))
    with pytest.raises(ValueError, match="No speech detected"):
        audio_service.trim_to_voice(payload)


def test_trim_padded_returns_speech_only(audio_service: AudioService):
    payload = audio_service.decode_wav(_padded_wav(0.6, 1.4, 0.6))
    trimmed, vad_ms = audio_service.trim_to_voice(payload)
    assert vad_ms >= 0.0
    duration = len(trimmed.waveform) / trimmed.sample_rate
    # Trimmed duration is the speech length plus any pre/post pad. Should
    # be < the original 2.6 s but well above the 1.4 s of pure speech.
    assert MIN_SPEECH_SECONDS <= duration < 2.6


def test_trim_below_minimum_raises(audio_service: AudioService):
    """Speech shorter than MIN_SPEECH_SECONDS after trimming surfaces as a
    user-actionable ValueError — the route maps it to HTTP 400."""
    short = _padded_wav(silence_before_s=0.5, speech_s=0.4, silence_after_s=0.5)
    payload = audio_service.decode_wav(short)
    with pytest.raises(ValueError, match=r"Detected only .+ of speech"):
        audio_service.trim_to_voice(payload)


# -----------------------------------------------------------------------------
# Verification pipeline integration
# -----------------------------------------------------------------------------


def test_verify_silent_recording_raises_value_error(verification_service, enrolled_user):
    """The integration assertion: a silent verification attempt fails fast
    via VAD instead of producing a meaningless similarity score."""
    user_id, _ = enrolled_user
    silent = _silence_wav(2.0)
    with pytest.raises(ValueError, match="No speech detected"):
        verification_service.verify(user_id=user_id, audio_bytes=silent)


def test_enrol_silent_recording_raises_value_error(verification_service):
    """Same defence on the enrolment side — silent samples never pollute
    the centroid."""
    silent = _silence_wav(2.0)
    with pytest.raises(ValueError, match="No speech detected"):
        verification_service.enroll(user_id="charlie", audio_bytes=silent)
