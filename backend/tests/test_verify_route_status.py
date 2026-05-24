from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes

from .conftest import make_wav


def _client(verification_service) -> TestClient:
    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification_service
    app.include_router(routes.router)
    return TestClient(app)


def test_verify_route_404_for_unknown_user(verification_service):
    client = _client(verification_service)

    response = client.post(
        "/verify",
        data={"user_id": "ghost"},
        files={"audio": ("clip.wav", make_wav(2.0), "audio/wav")},
    )

    assert response.status_code == 404
    assert "not enrolled" in response.json()["detail"].lower()


def test_verify_route_409_for_under_enrolled_user(verification_service, detector):
    detector.score = 0.9
    verification_service.enroll(user_id="bob", audio_bytes=make_wav(2.0), filename="bob.wav")
    client = _client(verification_service)

    response = client.post(
        "/verify",
        data={"user_id": "bob"},
        files={"audio": ("clip.wav", make_wav(2.0), "audio/wav")},
    )

    assert response.status_code == 409
    assert "needs" in response.json()["detail"].lower()
