"""T5 — `GET /spoof/engines` picker route + engine-level synth contract.

Each cloud engine (edge, gtts) has its own auto-skip path so the suite
stays hermetic by default. Run with `BIOVOICE_TEST_CLOUD_TTS=1` to hit
the real Microsoft / Google endpoints from a developer box.
"""

from __future__ import annotations

import os
from io import BytesIO
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes
from app.services.spoof import (
    EdgeTtsEngine,
    EspeakEngine,
    GttsEngine,
    SayEngine,
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


def test_engines_route_returns_all_five_known_engines(client: TestClient):
    response = client.get("/spoof/engines")
    assert response.status_code == 200
    body = response.json()
    ids = [e["id"] for e in body["engines"]]
    # v1.1.1 ships these five engines in this priority order. Anything
    # else in the catalogue is a regression that needs explicit attention.
    assert ids == ["say", "edge", "gtts", "espeak", "xtts"]


def test_engines_route_default_is_an_available_engine(client: TestClient):
    body = client.get("/spoof/engines").json()
    default = body["default_engine"]
    if default is None:
        # No engines available on this host — every entry must reflect
        # `available: False`. Acceptable on a stripped-down CI runner.
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
        assert isinstance(engine["requires_network"], bool)
        for voice in engine["voices"]:
            assert set(voice.keys()) == {"id", "label", "language"}


# ---------------------------------------------------------------------
# Engine availability + voice counts
# ---------------------------------------------------------------------


def test_say_engine_lists_voices_when_binary_present():
    engine = SayEngine()
    if not engine.is_available():
        pytest.skip("`say` binary not present (non-Mac host)")
    voices = engine.list_voices()
    assert len(voices) > 0
    # macOS bundles standard voices like Alex, Samantha, Daniel.
    ids = {v.id for v in voices}
    assert any(id_ in ids for id_ in ("Alex", "Samantha", "Daniel"))
    assert engine.default_voice() in ids


def test_espeak_engine_lists_languages_when_binary_present():
    engine = EspeakEngine()
    if not engine.is_available():
        pytest.skip("espeak-ng / espeak binary not present")
    voices = engine.list_voices()
    assert len(voices) > 0
    assert engine.default_voice() == "en"


def test_edge_engine_returns_curated_voice_list():
    engine = EdgeTtsEngine()
    if not engine.is_available():
        pytest.skip("edge-tts package not installed")
    voices = engine.list_voices()
    # The curated list is fixed at 12; if it changes the picker tests
    # need to be re-verified.
    assert len(voices) == 12
    assert engine.default_voice() == "en-US-AriaNeural"


def test_gtts_engine_lists_languages_with_hebrew_quirk():
    engine = GttsEngine()
    if not engine.is_available():
        pytest.skip("gTTS package not installed")
    voices = engine.list_voices()
    ids = {v.id for v in voices}
    # gTTS uses the legacy ISO code "iw" for Hebrew, NOT "he".
    assert "iw" in ids and "he" not in ids
    assert engine.default_voice() == "en"


def test_xtts_engine_unavailable_when_checkpoint_missing(tmp_path):
    engine = XttsEngine(tmp_path / "nope")
    assert not engine.is_available()
    assert engine.default_voice() is None
    assert engine.list_voices() == []


# ---------------------------------------------------------------------
# POST /spoof routes through the chosen engine
# ---------------------------------------------------------------------


def test_spoof_404s_when_engine_id_is_unknown(client: TestClient):
    response = client.post(
        "/spoof",
        data={
            "target_user_id": "alice",
            "text": "hello",
            "engine": "not-a-real-engine",
        },
    )
    # Unknown engine is a 400 (ValueError → "Unknown TTS engine").
    assert response.status_code == 400
    assert "Unknown TTS engine" in response.json()["detail"]


def test_spoof_503s_when_engine_is_known_but_unavailable(client: TestClient):
    # XTTS is registered but the test fixture's checkpoint dir is empty,
    # so it's not available. The route should map that to 503.
    response = client.post(
        "/spoof",
        data={
            "target_user_id": "alice",
            "text": "hello",
            "engine": "xtts",
        },
    )
    assert response.status_code == 503


def test_spoof_returns_engine_and_voice_headers(client: TestClient):
    if not SayEngine().is_available():
        pytest.skip("`say` not available on this host")
    response = client.post(
        "/spoof",
        data={
            "target_user_id": "alice",
            "text": "Two-factor authentication compromised.",
            "engine": "say",
            "voice": "Samantha",
        },
    )
    assert response.status_code == 200
    assert response.headers.get("X-Spoof-Engine") == "say"
    assert response.headers.get("X-Spoof-Voice") == "Samantha"
    assert len(response.content) > 1000  # real WAV bytes
    assert response.content[:4] == b"RIFF"  # WAV magic


# ---------------------------------------------------------------------
# Live cloud smoke tests (skipped by default; gated by env flag)
# ---------------------------------------------------------------------


def _cloud_tts_enabled() -> bool:
    return os.environ.get("BIOVOICE_TEST_CLOUD_TTS", "").lower() in {"1", "true", "yes"}


@pytest.mark.skipif(not _cloud_tts_enabled(), reason="cloud TTS gated; set BIOVOICE_TEST_CLOUD_TTS=1")
def test_edge_engine_synthesizes_real_audio():
    engine = EdgeTtsEngine()
    if not engine.is_available():
        pytest.skip("edge-tts not installed")
    audio = engine.synthesize(
        text="Verification challenge initiated.",
        voice_id="en-US-AriaNeural",
        language="en",
        target_sample_rate=16000,
    )
    assert len(audio) > 1000
    assert audio[:4] == b"RIFF"


@pytest.mark.skipif(not _cloud_tts_enabled(), reason="cloud TTS gated; set BIOVOICE_TEST_CLOUD_TTS=1")
def test_gtts_engine_synthesizes_real_audio():
    engine = GttsEngine()
    if not engine.is_available():
        pytest.skip("gTTS not installed")
    audio = engine.synthesize(
        text="Verification challenge initiated.",
        voice_id="en",
        language="en",
        target_sample_rate=16000,
    )
    assert len(audio) > 1000
    assert audio[:4] == b"RIFF"
