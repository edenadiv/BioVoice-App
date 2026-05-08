"""Shared fixtures for backend tests."""

from __future__ import annotations

from io import BytesIO
import math
import wave

import pytest

import hashlib
import math

from app.services.audio import AudioService
from app.services.verification import VerificationService
from app.storage.memory_store import MemoryStore


SAMPLE_RATE = 16000


def make_wav(
    duration_s: float,
    *,
    frequency: float = 220.0,
    amplitude: float = 0.3,
    waveform: str = "sine",
    seed: int = 0,
) -> bytes:
    """Generate a 16-bit PCM mono WAV at SAMPLE_RATE.

    `waveform` selects sine or pseudo-random noise (seeded for repeatability).
    Tests use distinct waveform shapes to make voice-mismatch behaviour
    detectable through the lightweight PlaceholderSpeakerEncoder.
    """
    import random

    n = int(duration_s * SAMPLE_RATE)
    samples = bytearray()
    if waveform == "noise":
        rng = random.Random(seed)
        for _ in range(n):
            value = int(amplitude * 32767 * (rng.random() * 2 - 1))
            samples += value.to_bytes(2, "little", signed=True)
    else:
        for i in range(n):
            value = int(amplitude * 32767 * math.sin(2 * math.pi * frequency * i / SAMPLE_RATE))
            samples += value.to_bytes(2, "little", signed=True)
    buffer = BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SAMPLE_RATE)
        handle.writeframes(bytes(samples))
    return buffer.getvalue()


class StubDetector:
    """Detector stub: returns whatever score the test sets."""

    def __init__(self, score: float = 0.9):
        self.score = score

    def detect(self, _waveform: list[float]) -> float:
        return self.score


class HashEncoder:
    """Deterministic mock encoder for tests.

    Buckets the waveform shape into a hash and emits a unit-length 8-d vector.
    Two recordings of the same shape produce identical embeddings; different
    shapes produce orthogonal-ish embeddings, so similarity collapses below
    threshold for the REJECT-path test.
    """

    DIM = 8

    def embed(self, waveform: list[float]) -> list[float]:
        if not waveform:
            return [0.0] * self.DIM
        # Quantise so floating-point noise across calls hashes the same.
        digest = hashlib.sha256(
            b"".join(int(round(s * 1024)).to_bytes(2, "little", signed=True) for s in waveform)
        ).digest()
        raw = [int.from_bytes(digest[i : i + 4], "little", signed=False) / 0xFFFFFFFF for i in range(0, self.DIM * 4, 4)]
        # Re-center so similar shapes can co-vary; magnitude lives in the L2 norm
        centered = [v - 0.5 for v in raw]
        norm = math.sqrt(sum(v * v for v in centered)) or 1.0
        return [v / norm for v in centered]

    @staticmethod
    def cosine_similarity(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(y * y for y in b))
        denom = norm_a * norm_b
        if denom <= 1e-8:
            return 0.0
        return (dot / denom + 1.0) / 2.0


@pytest.fixture
def store() -> MemoryStore:
    return MemoryStore()


@pytest.fixture
def detector() -> StubDetector:
    return StubDetector(score=0.9)


@pytest.fixture
def encoder() -> HashEncoder:
    return HashEncoder()


@pytest.fixture
def verification_service(store, detector, encoder) -> VerificationService:
    service = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=encoder,
        sample_rate=SAMPLE_RATE,
        similarity_threshold=0.75,
        deepfake_threshold=0.5,
        min_enrollment_samples=3,
    )
    # Sanity: AudioService is constructed inside the service; share for tests.
    service.audio = AudioService(target_sample_rate=SAMPLE_RATE)
    return service


@pytest.fixture
def enrolled_user(verification_service):
    """Enrol user 'alice' with 3 samples of identical synthetic audio."""
    user_id = "alice"
    wav = make_wav(2.0, frequency=220.0)
    for _ in range(3):
        verification_service.enroll(user_id=user_id, audio_bytes=wav, filename="enroll.wav")
    return user_id, wav
