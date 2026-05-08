"""Tests for `GET /users/{user_id}/availability` (Y-17).

The endpoint backs the Enroll-screen "ID Available" pill (Y-13). Validates the
user_id pattern at the route level (422 for malformed) and reflects whether
the speaker is already enrolled (200 with available: bool).
"""

from __future__ import annotations

from app.services.verification import VerificationService

from .conftest import make_wav


def test_availability_true_for_unknown_user(verification_service: VerificationService) -> None:
    assert verification_service.is_user_id_available("never-enrolled") is True


def test_availability_false_after_enroll(verification_service: VerificationService, detector) -> None:
    detector.score = 0.9
    verification_service.enroll(user_id="taken_user", audio_bytes=make_wav(1.0), filename="x.wav")
    assert verification_service.is_user_id_available("taken_user") is False


def test_availability_endpoint_via_test_client(monkeypatch) -> None:
    """End-to-end via FastAPI TestClient — covers the regex validator."""
    from fastapi.testclient import TestClient

    from app.api import dependencies, routes
    from app.services.detector import DeepfakeDetectorService

    from . import conftest as cf

    store = cf.MemoryStore()
    encoder = cf.HashEncoder()
    detector = cf.StubDetector(score=0.9)
    service = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=encoder,
        sample_rate=cf.SAMPLE_RATE,
        similarity_threshold=0.75,
        deepfake_threshold=0.5,
        min_enrollment_samples=3,
    )

    from fastapi import FastAPI

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: service
    app.dependency_overrides[dependencies.get_detector_service] = lambda: detector  # type: ignore[arg-type]
    app.include_router(routes.router)

    client = TestClient(app)

    # Empty store → available
    response = client.get("/users/test_user/availability")
    assert response.status_code == 200
    assert response.json() == {"available": True}

    # After enroll → taken
    service.enroll(user_id="test_user", audio_bytes=make_wav(1.0), filename="x.wav")
    response = client.get("/users/test_user/availability")
    assert response.status_code == 200
    assert response.json() == {"available": False}

    # Bad shape (too short)
    response = client.get("/users/ab/availability")
    assert response.status_code == 422

    # Illegal char (space gets percent-encoded by httpx) — regex rejects.
    response = client.get("/users/has space/availability")
    assert response.status_code == 422

    # Bad shape (too long)
    response = client.get(f"/users/{'a' * 33}/availability")
    assert response.status_code == 422
