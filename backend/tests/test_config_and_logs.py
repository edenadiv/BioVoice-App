"""GET/PATCH /config (runtime-tunable thresholds + model participation)
and GET /logs (unified verify + identify history)."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes
from app.core.container import AppContainer
from app.services.verification import VerificationService


@pytest.fixture
def container(verification_service, store, detector) -> AppContainer:
    # No real models loaded — exercises the "comparison model unavailable"
    # path and keeps these tests fast.
    return AppContainer(
        settings=None,
        store=store,
        detector=detector,
        verification_service=verification_service,
        spoof_service=None,
        loaded_comparison_encoders={},
    )


@pytest.fixture
def client(verification_service: VerificationService, container: AppContainer) -> TestClient:
    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification_service
    app.include_router(routes.router)
    app.state.container = container
    return TestClient(app)


# -- /config ------------------------------------------------------------------


def test_get_config_returns_effective_values(client: TestClient):
    body = client.get("/config").json()
    assert body["similarity_threshold"] == 0.75
    assert body["deepfake_threshold"] == 0.5
    assert body["identify_top_n"] == 3
    keys = {m["key"]: m for m in body["models"]}
    assert keys["redimnet_b5"]["participating"] is True
    assert keys["redimnet_b5"]["can_toggle"] is False
    # ECAPA/WeSpeaker weren't loaded in this container → not toggleable.
    assert keys["ecapa_voxceleb"]["loaded"] is False
    assert keys["ecapa_voxceleb"]["can_toggle"] is False


def test_patch_config_updates_live_service_and_persists(
    client: TestClient, verification_service: VerificationService, store
):
    resp = client.patch("/config", json={"similarity_threshold": 0.9, "identify_top_n": 5})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["similarity_threshold"] == 0.9
    assert body["identify_top_n"] == 5
    # Applied to the live service immediately…
    assert verification_service.similarity_threshold == 0.9
    assert verification_service.identify_top_n == 5
    # …and persisted so a restart restores it.
    assert store.get_config_overrides()["similarity_threshold"] == 0.9


def test_patch_config_rejects_out_of_bounds(client: TestClient):
    resp = client.patch("/config", json={"deepfake_threshold": 1.5})
    assert resp.status_code == 422


def test_patch_enable_unavailable_model_returns_400(client: TestClient):
    resp = client.patch("/config", json={"enable_ecapa_comparison": True})
    assert resp.status_code == 400
    assert "not available" in resp.json()["detail"].lower()


# -- /logs --------------------------------------------------------------------


def test_logs_list_includes_verify_and_identify(
    client: TestClient, verification_service: VerificationService, enrolled_user
):
    user_id, wav = enrolled_user
    verify = verification_service.verify(user_id=user_id, audio_bytes=wav, filename="q.wav")
    identify = verification_service.identify(audio_bytes=wav)

    logs = client.get("/logs").json()
    kinds = {entry["kind"] for entry in logs}
    assert kinds == {"verify", "identify"}
    ids = {entry["id"] for entry in logs}
    assert verify.result_id in ids
    assert identify.result_id in ids


def test_log_detail_and_audio_roundtrip(
    client: TestClient, verification_service: VerificationService, enrolled_user
):
    user_id, wav = enrolled_user
    verify = verification_service.verify(user_id=user_id, audio_bytes=wav, filename="q.wav")

    detail = client.get(f"/logs/{verify.result_id}").json()
    assert detail["kind"] == "verify"
    assert detail["verify"]["user_id"] == user_id
    assert detail["has_audio"] is True

    audio = client.get(f"/logs/{verify.result_id}/audio")
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/wav"
    assert audio.content  # the stored WAV bytes

    assert client.get("/logs/does-not-exist").status_code == 404


def test_identify_run_audio_is_retained(
    client: TestClient, verification_service: VerificationService, enrolled_user
):
    _, wav = enrolled_user
    identify = verification_service.identify(audio_bytes=wav)
    assert client.get(f"/logs/{identify.result_id}/audio").status_code == 200
