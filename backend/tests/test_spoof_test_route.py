"""G14 — `/me/spoof/test` route tests.

Covers:
  - 200 + SpoofTestResponse on a valid uploaded WAV
  - decision flips on the deepfake_threshold boundary (FAKE vs GENUINE)
  - 400 on empty audio
  - 400 on silent audio (VAD short-circuit)
  - 401 when no session cookie + no Bearer token
"""

from __future__ import annotations

from io import BytesIO
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes
from app.services.auth import AuthService
from app.services.verification import VerificationService
from app.storage.memory_store import MemoryStore

from .conftest import HashEncoder, SAMPLE_RATE, StubDetector, make_wav


def _silence_wav(duration_s: float) -> bytes:
    n = int(duration_s * SAMPLE_RATE)
    buf = BytesIO()
    with wave.open(buf, "wb") as h:
        h.setnchannels(1)
        h.setsampwidth(2)
        h.setframerate(SAMPLE_RATE)
        h.writeframes(b"\x00\x00" * n)
    return buf.getvalue()


def _build_app() -> tuple[TestClient, MemoryStore, VerificationService, StubDetector]:
    """Login uses the same detector as /verify, so we always seed the
    detector with a passing score (0.9) and let individual tests mutate
    `detector.score` AFTER login to exercise the spoof-test branches."""
    store = MemoryStore()
    detector = StubDetector(score=0.9)
    encoder = HashEncoder()
    verification = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=encoder,
        sample_rate=SAMPLE_RATE,
        similarity_threshold=0.75,
        deepfake_threshold=0.5,
        min_enrollment_samples=3,
    )
    auth = AuthService(store=store, verification_service=verification, idle_seconds=600)

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_auth_service] = lambda: auth
    app.include_router(routes.router)
    return TestClient(app, base_url="https://testserver"), store, verification, detector


def _login(client: TestClient, verification: VerificationService) -> None:
    """Enrol + login `alice` so subsequent calls have a valid session cookie."""
    wav = make_wav(2.0)
    for _ in range(3):
        verification.enroll(user_id="alice", audio_bytes=wav, filename="enrol.wav")
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 200, resp.text


def test_spoof_test_returns_genuine_for_high_score():
    client, _, verification, detector = _build_app()
    detector.score = 0.92
    _login(client, verification)
    wav = make_wav(2.0)
    resp = client.post("/me/spoof/test", files={"audio": ("clip.wav", wav, "audio/wav")})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["decision"] == "GENUINE"
    assert body["deepfake_score"] == pytest.approx(0.92)
    # AnalysisDetails is the F4 sub-classifier output — must have all 4 axes.
    assert set(body["analysis_details"].keys()) == {
        "voice_naturalness",
        "spectral_consistency",
        "temporal_patterns",
        "artifact_detection",
    }


def test_spoof_test_returns_fake_for_low_score():
    client, _, verification, detector = _build_app()
    _login(client, verification)
    # Login passed against 0.9; flip the detector to a synthetic-looking
    # 0.10 for the spoof-test call only.
    detector.score = 0.10
    wav = make_wav(2.0)
    resp = client.post("/me/spoof/test", files={"audio": ("clip.wav", wav, "audio/wav")})
    assert resp.status_code == 200
    assert resp.json()["decision"] == "FAKE"


def test_spoof_test_rejects_empty_audio():
    client, _, verification, _ = _build_app()
    _login(client, verification)
    resp = client.post(
        "/me/spoof/test", files={"audio": ("empty.wav", b"", "audio/wav")}
    )
    assert resp.status_code == 400
    assert "empty" in resp.json()["detail"].lower()


def test_spoof_test_rejects_silent_audio():
    """F3.2 VAD short-circuit — silence has no speech to analyse."""
    client, _, verification, _ = _build_app()
    _login(client, verification)
    silent = _silence_wav(2.0)
    resp = client.post(
        "/me/spoof/test", files={"audio": ("silent.wav", silent, "audio/wav")}
    )
    assert resp.status_code == 400
    assert "speech" in resp.json()["detail"].lower()


def test_spoof_test_requires_session():
    client, _, _, _ = _build_app()
    # No login → no cookie → 401
    wav = make_wav(2.0)
    resp = client.post("/me/spoof/test", files={"audio": ("clip.wav", wav, "audio/wav")})
    assert resp.status_code == 401
