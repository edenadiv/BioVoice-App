"""`GET /spoof/engines` picker route + cloning-engine contract.

v1.2 dropped the generic TTS engines (say / espeak / edge / gtts) — they
spoke in a stranger's voice and never matched the enrolled target. Only
voice-cloning engines remain: F5-TTS and XTTS-v2. Both condition on a
reference WAV and are unavailable in CI (no model weights / packages),
so the route tests exercise the picker shape + the failure paths.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes
from app.services.spoof import (
    F5TtsEngine,
    SpoofGenerationService,
    XttsEngine,
)
from app.storage.memory_store import MemoryStore


@pytest.fixture
def spoof_service(tmp_path) -> SpoofGenerationService:
    return SpoofGenerationService(
        store=MemoryStore(),
        model_path=tmp_path / "missing-xtts-checkpoint",
        output_directory=tmp_path / "spoof_out",
        default_language="en",
        output_sample_rate=16000,
    )


@pytest.fixture
def client(spoof_service: SpoofGenerationService) -> TestClient:
    app = FastAPI()
    app.dependency_overrides[dependencies.get_spoof_generation_service] = lambda: spoof_service
    app.include_router(routes.router)
    return TestClient(app)


# ---------------------------------------------------------------------
# GET /spoof/engines — shape + ordering + default pick
# ---------------------------------------------------------------------


def test_engines_route_returns_only_cloning_engines(client: TestClient):
    response = client.get("/spoof/engines")
    assert response.status_code == 200
    body = response.json()
    ids = [e["id"] for e in body["engines"]]
    # v1.2 ships exactly these two cloning engines, F5 first (priority).
    assert ids == ["f5", "xtts"]


def test_engines_route_default_is_an_available_engine(client: TestClient):
    body = client.get("/spoof/engines").json()
    default = body["default_engine"]
    if default is None:
        # No cloning engine installed on this host — every entry must
        # reflect `available: False`. The default state on a CI runner.
        assert all(not e["available"] for e in body["engines"])
    else:
        match = next(e for e in body["engines"] if e["id"] == default)
        assert match["available"], f"default engine {default!r} is marked unavailable"


def test_engine_descriptor_shape_is_stable(client: TestClient):
    body = client.get("/spoof/engines").json()
    for engine in body["engines"]:
        assert set(engine.keys()) == {
            "id", "label", "description", "requires_network",
            "available", "voices", "default_voice",
        }
        assert isinstance(engine["available"], bool)
        # Cloning engines run locally — never network-gated.
        assert engine["requires_network"] is False
        for voice in engine["voices"]:
            assert set(voice.keys()) == {"id", "label", "language"}


# ---------------------------------------------------------------------
# Engine availability — both are unavailable without weights/packages
# ---------------------------------------------------------------------


def test_xtts_engine_unavailable_when_checkpoint_missing(tmp_path):
    engine = XttsEngine(tmp_path / "nope")
    assert not engine.is_available()
    assert engine.default_voice() is None
    assert engine.list_voices() == []


def test_f5_engine_voice_contract_tracks_availability():
    engine = F5TtsEngine()
    if engine.is_available():
        # Package installed — exposes the single `enrolled` pseudo-voice.
        assert engine.default_voice() == "enrolled"
        assert [v.id for v in engine.list_voices()] == ["enrolled"]
    else:
        assert engine.default_voice() is None
        assert engine.list_voices() == []


# ---------------------------------------------------------------------
# POST /spoof routes through the chosen engine
# ---------------------------------------------------------------------


def test_spoof_400s_when_engine_id_is_unknown(client: TestClient):
    response = client.post(
        "/spoof",
        data={
            "target_user_id": "alice",
            "text": "hello",
            "engine": "not-a-real-engine",
        },
    )
    # Unknown engine is a 400 (ValueError → "Unknown cloning engine").
    assert response.status_code == 400
    assert "Unknown cloning engine" in response.json()["detail"]


def test_spoof_503s_when_engine_is_known_but_unavailable(client: TestClient):
    # XTTS is registered but the fixture's checkpoint dir is empty, so
    # it's not available. The route should map that to 503.
    response = client.post(
        "/spoof",
        data={
            "target_user_id": "alice",
            "text": "hello",
            "engine": "xtts",
        },
    )
    assert response.status_code == 503
