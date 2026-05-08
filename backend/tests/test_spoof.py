"""Tests for `POST /me/spoof/test` (Y-18) and analysis_details_from_score (Y-19)."""

from __future__ import annotations

import hashlib

import pytest

from app.schemas import AnalysisDetails
from app.services.detector import analysis_details_from_score

from .conftest import make_wav


# -----------------------------------------------------------------------------
# Y-19 — analysis_details_from_score
# -----------------------------------------------------------------------------


def test_sub_scores_track_global_score_within_jitter() -> None:
    score = 0.92
    details = analysis_details_from_score(score, audio_hash="abc123")
    for metric in (details.voice_naturalness, details.spectral_consistency, details.temporal_patterns):
        assert abs(metric - score) <= 0.02
    # artifact_detection inverts.
    assert abs(details.artifact_detection - (1.0 - score)) <= 0.02


def test_sub_scores_clamped_to_unit_interval() -> None:
    # Edge cases: score at boundaries should still produce valid outputs.
    for score in (0.0, 0.01, 0.5, 0.99, 1.0):
        details = analysis_details_from_score(score, audio_hash="seed")
        for metric in (
            details.voice_naturalness,
            details.spectral_consistency,
            details.temporal_patterns,
            details.artifact_detection,
        ):
            assert 0.0 <= metric <= 1.0


def test_sub_scores_stable_for_same_audio_hash() -> None:
    a = analysis_details_from_score(0.7, audio_hash="stable-hash")
    b = analysis_details_from_score(0.7, audio_hash="stable-hash")
    assert a == b


def test_sub_scores_diverge_across_different_audio_hashes() -> None:
    """Different audio should produce different jitter — proves seeding works."""
    seen: set[tuple[float, float, float, float]] = set()
    for i in range(50):
        details = analysis_details_from_score(0.7, audio_hash=f"hash-{i}")
        seen.add(
            (
                round(details.voice_naturalness, 6),
                round(details.spectral_consistency, 6),
                round(details.temporal_patterns, 6),
                round(details.artifact_detection, 6),
            )
        )
    # 50 distinct hashes should produce many distinct tuples.
    assert len(seen) > 30


def test_returns_pydantic_model() -> None:
    details = analysis_details_from_score(0.5, audio_hash="x")
    assert isinstance(details, AnalysisDetails)


# -----------------------------------------------------------------------------
# Y-18 — POST /me/spoof/test (FastAPI integration)
# -----------------------------------------------------------------------------


@pytest.fixture
def spoof_test_client(verification_service):
    """Boot a stripped-down FastAPI app wired to the in-memory store + stub detector."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import dependencies, routes
    from app.services.auth import AuthService

    auth_service = AuthService(store=verification_service.store, verification_service=verification_service)

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification_service
    app.dependency_overrides[dependencies.get_auth_service] = lambda: auth_service
    app.dependency_overrides[dependencies.get_detector_service] = lambda: verification_service.detector
    app.include_router(routes.router)

    return TestClient(app), auth_service


def _login(verification_service, client, user_id: str = "alice") -> str:
    """Enrol the user and obtain a session token via /auth/login."""
    wav = make_wav(2.0)
    for _ in range(3):
        verification_service.enroll(user_id=user_id, audio_bytes=wav, filename="enroll.wav")
    response = client.post(
        "/auth/login",
        data={"user_id": user_id},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert response.status_code == 200, response.text
    return response.json()["session"]["session_token"]


def test_spoof_test_genuine(spoof_test_client, verification_service, detector):
    client, _auth = spoof_test_client
    detector.score = 0.92  # genuine
    token = _login(verification_service, client)

    wav = make_wav(2.0)
    response = client.post(
        "/me/spoof/test",
        files={"audio": ("test.wav", wav, "audio/wav")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["decision"] == "GENUINE"
    assert body["deepfake_score"] == pytest.approx(0.92, abs=1e-6)
    details = body["analysis_details"]
    assert 0.0 <= details["voice_naturalness"] <= 1.0
    assert 0.0 <= details["artifact_detection"] <= 1.0


def test_spoof_test_fake(spoof_test_client, verification_service, detector):
    client, _auth = spoof_test_client
    # Login uses the detector's score too — set high so login succeeds, then flip.
    detector.score = 0.9
    token = _login(verification_service, client)
    detector.score = 0.04  # synthetic
    wav = make_wav(2.0)

    response = client.post(
        "/me/spoof/test",
        files={"audio": ("fake.wav", wav, "audio/wav")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["decision"] == "FAKE"
    assert body["deepfake_score"] < 0.5


def test_spoof_test_requires_auth(spoof_test_client):
    client, _auth = spoof_test_client
    wav = make_wav(2.0)
    response = client.post("/me/spoof/test", files={"audio": ("x.wav", wav, "audio/wav")})
    assert response.status_code == 401


def test_spoof_test_rejects_empty_audio(spoof_test_client, verification_service, detector):
    client, _auth = spoof_test_client
    detector.score = 0.9
    token = _login(verification_service, client)
    response = client.post(
        "/me/spoof/test",
        files={"audio": ("empty.wav", b"", "audio/wav")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 400


def test_spoof_test_rejects_bad_wav(spoof_test_client, verification_service, detector):
    client, _auth = spoof_test_client
    detector.score = 0.9
    token = _login(verification_service, client)
    response = client.post(
        "/me/spoof/test",
        files={"audio": ("garbage.wav", b"not a wav file", "audio/wav")},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 400


# -----------------------------------------------------------------------------
# Verification service uses Y-19 derivation in its responses
# -----------------------------------------------------------------------------


def test_verification_response_carries_real_sub_scores(verification_service, enrolled_user, detector):
    user_id, wav = enrolled_user
    detector.score = 0.88

    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    expected = analysis_details_from_score(
        0.88, audio_hash=hashlib.sha256(wav).hexdigest()
    )
    assert result.analysis_details is not None
    assert result.analysis_details.voice_naturalness == pytest.approx(expected.voice_naturalness)
    assert result.analysis_details.artifact_detection == pytest.approx(expected.artifact_detection)
