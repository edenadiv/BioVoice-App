"""Public spoof + spoof-test endpoints (Phase B — replacements for the
deleted cookie-gated /me/spoof and /me/spoof/test).

`/spoof` defers to SpoofGenerationService.generate which requires XTTS
to be installed for a real run; in CI we exercise the failure path
(503 when XTTS isn't wired) and the input-validation paths. The happy
path is covered by the local manual smoke when XTTS is installed.

`/spoof/test` is fully exercised — it only needs the AASIST detector
+ AcousticProbe, both available from the test conftest fixtures.
"""

from __future__ import annotations

from io import BytesIO
import wave

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes
from app.services.spoof import ImportedVoiceModel, SpoofGenerationResult, SpoofGenerationService
from app.services.verification import VerificationService
from app.storage.memory_store import MemoryStore

from .conftest import HashEncoder, SAMPLE_RATE, StubDetector, make_wav


class _StubSpoofService:
    """Stub for SpoofGenerationService — raises RuntimeError to mimic
    the XTTS-not-installed path. Tests can flip `mode` to vary the
    failure shape."""

    def __init__(self) -> None:
        self.mode: str = "xtts_unavailable"  # or "value_error" or "ok"
        self.models: list[ImportedVoiceModel] = []

    def generate(self, **kwargs):  # noqa: D401 — stub signature
        if self.mode == "xtts_unavailable":
            raise RuntimeError("XTTS engine is not installed")
        if self.mode == "value_error":
            raise ValueError("Unknown target user")
        return SpoofGenerationResult(
            audio_bytes=make_wav(1.0),
            file_name="clone.wav",
            source_description="stub",
            engine_id="stub",
            voice_id=None,
        )

    def list_voice_models(self) -> list[ImportedVoiceModel]:
        return list(self.models)

    def import_voice_model(
        self,
        *,
        engine: str,
        label: str,
        language: str | None,
        model_bytes: bytes,
        model_filename: str,
        index_bytes: bytes | None = None,
        index_filename: str | None = None,
    ) -> ImportedVoiceModel:
        if engine not in {"rvc", "applio"}:
            raise ValueError("Only `rvc` and `applio` support imported voice models.")
        if engine == "applio" and index_bytes is None:
            raise ValueError("Applio imports require both a `.pth` model and a `.index` file.")
        imported = ImportedVoiceModel(
            engine=engine,
            model_id=f"{engine}-{len(self.models) + 1}",
            label=label,
            language=language,
            model_path=None,
            model_filename=model_filename,
            index_path=None,
            index_filename=index_filename,
            ready=engine == "rvc" or index_filename is not None,
        )
        self.models.append(imported)
        return imported


def _silence_wav(duration_s: float) -> bytes:
    n = int(duration_s * SAMPLE_RATE)
    buf = BytesIO()
    with wave.open(buf, "wb") as h:
        h.setnchannels(1)
        h.setsampwidth(2)
        h.setframerate(SAMPLE_RATE)
        h.writeframes(b"\x00\x00" * n)
    return buf.getvalue()


def _build_app() -> tuple[
    TestClient, MemoryStore, VerificationService, StubDetector, _StubSpoofService
]:
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
    spoof_stub = _StubSpoofService()

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_spoof_generation_service] = lambda: spoof_stub
    app.include_router(routes.router)
    return (
        TestClient(app, base_url="https://testserver"),
        store,
        verification,
        detector,
        spoof_stub,
    )


# -----------------------------------------------------------------------------
# /spoof/test (the only public route that's hermetic in CI)
# -----------------------------------------------------------------------------


def test_spoof_test_returns_genuine_for_high_score():
    client, _, _, detector, _ = _build_app()
    detector.score = 0.92
    wav = make_wav(2.0)
    resp = client.post("/spoof/test", files={"audio": ("clip.wav", wav, "audio/wav")})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["decision"] == "GENUINE"
    assert body["deepfake_score"] == pytest.approx(0.92)
    # HF3 added a `mode` key alongside the four axes; assert subset so
    # the test isn't brittle to schema additions.
    assert {
        "voice_naturalness",
        "spectral_consistency",
        "temporal_patterns",
        "artifact_detection",
    } <= set(body["analysis_details"].keys())


def test_spoof_test_returns_fake_for_low_score():
    client, _, _, detector, _ = _build_app()
    detector.score = 0.10
    wav = make_wav(2.0)
    resp = client.post("/spoof/test", files={"audio": ("clip.wav", wav, "audio/wav")})
    assert resp.status_code == 200
    assert resp.json()["decision"] == "FAKE"


def test_spoof_test_rejects_empty_audio():
    client, _, _, _, spoof = _build_app()
    resp = client.post("/spoof/test", files={"audio": ("empty.wav", b"", "audio/wav")})
    assert resp.status_code == 400


def test_spoof_test_rejects_silent_audio():
    """VAD short-circuit — silence has no speech to analyse."""
    client, _, _, _, spoof = _build_app()
    silent = _silence_wav(2.0)
    resp = client.post("/spoof/test", files={"audio": ("silent.wav", silent, "audio/wav")})
    assert resp.status_code == 400
    assert "speech" in resp.json()["detail"].lower()


def test_spoof_test_does_not_require_authentication():
    """No cookie, no X-Admin-API-Key — 200 just on the WAV upload."""
    client, _, _, _, spoof = _build_app()
    wav = make_wav(2.0)
    resp = client.post(
        "/spoof/test",
        files={"audio": ("clip.wav", wav, "audio/wav")},
        # No cookies in the jar; no auth header.
    )
    assert resp.status_code == 200


# -----------------------------------------------------------------------------
# /spoof — input-validation only (XTTS isn't installed in CI)
# -----------------------------------------------------------------------------


def test_spoof_rejects_empty_audio_payload():
    client, _, _, _, spoof = _build_app()
    resp = client.post(
        "/spoof",
        data={"target_user_id": "alice", "text": "hello"},
        files={"audio": ("empty.wav", b"", "audio/wav")},
    )
    assert resp.status_code == 400
    assert "empty" in resp.json()["detail"].lower()


def test_spoof_503_when_xtts_unavailable():
    """SpoofGenerationService raises RuntimeError when XTTS isn't
    installed → route maps to 503."""
    client, _, _, _, spoof = _build_app()
    spoof.mode = "xtts_unavailable"
    resp = client.post(
        "/spoof",
        data={"target_user_id": "alice", "text": "hello", "language": "en"},
    )
    assert resp.status_code == 503, resp.text
    assert "XTTS" in resp.json()["detail"]


def test_spoof_400_on_unknown_target_user():
    """ValueError from the service (e.g. unknown target_user_id) → 400."""
    client, _, _, _, spoof = _build_app()
    spoof.mode = "value_error"
    resp = client.post(
        "/spoof",
        data={"target_user_id": "nobody", "text": "hello", "language": "en"},
    )
    assert resp.status_code == 400
    assert "Unknown target user" in resp.json()["detail"]


def test_spoof_200_returns_wav_with_source_header():
    """Happy path — service returns SpoofGenerationResult, route streams
    the audio back with the X-Spoof-Source header set."""
    client, _, _, _, spoof = _build_app()
    spoof.mode = "ok"
    resp = client.post(
        "/spoof",
        data={"target_user_id": "alice", "text": "hello", "language": "en"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "audio/wav"
    assert resp.headers["x-spoof-source"] == "stub"
    assert "clone.wav" in resp.headers["content-disposition"]
    assert len(resp.content) > 0


def test_list_spoof_voice_models_returns_imported_models():
    client, _, _, _, spoof = _build_app()
    spoof.models.append(
        ImportedVoiceModel(
            engine="rvc",
            model_id="rvc-demo",
            label="Demo Voice",
            language="en",
            model_path=None,
            model_filename="demo.pth",
            index_path=None,
            index_filename=None,
            ready=True,
        )
    )

    resp = client.get("/spoof/voice-models")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {
        "models": [
            {
                "engine": "rvc",
                "model_id": "rvc-demo",
                "label": "Demo Voice",
                "language": "en",
                "ready": True,
                "model_filename": "demo.pth",
                "index_filename": None,
            }
        ]
    }


def test_import_spoof_voice_model_accepts_rvc_model():
    client, _, _, _, spoof = _build_app()
    resp = client.post(
        "/spoof/voice-models/import",
        data={"engine": "rvc", "label": "Operator A", "language": "en"},
        files={"model_file": ("operator-a.pth", b"weights", "application/octet-stream")},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["engine"] == "rvc"
    assert body["label"] == "Operator A"
    assert body["model_filename"] == "operator-a.pth"
    assert spoof.models[-1].model_id == body["model_id"]


def test_import_spoof_voice_model_rejects_missing_applio_index():
    client, _, _, _, spoof = _build_app()
    resp = client.post(
        "/spoof/voice-models/import",
        data={"engine": "applio", "label": "Operator B"},
        files={"model_file": ("operator-b.pth", b"weights", "application/octet-stream")},
    )
    assert resp.status_code == 400, resp.text
    assert "Applio" in resp.json()["detail"]
