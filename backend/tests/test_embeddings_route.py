"""V1 — `GET /users/embeddings` and `POST /embed` routes.

Feeds the operator-console EmbeddingConstellation: real per-profile
centroids + per-sample embeddings, plus an encoder-only pass for the
live moving point. Tests use the HashEncoder fixture (DIM=8); the
192-d real-ReDimNet contract is asserted in
test_real_models_integration.py.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes
from app.models import SpeakerRecord
from app.services.verification import VerificationService

from .conftest import HashEncoder, make_wav


@pytest.fixture
def client(verification_service: VerificationService) -> TestClient:
    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification_service
    app.include_router(routes.router)
    return TestClient(app)


def _seed(verification_service: VerificationService, user_id: str, wav: bytes, n: int = 3) -> SpeakerRecord:
    """Install a SpeakerRecord directly, bypassing the SNR quality gate."""
    payload = verification_service.audio.decode_wav(wav)
    trimmed, _ = verification_service.audio.trim_to_voice(payload)
    embedding = verification_service.encoder.embed(trimmed.waveform)
    samples = [embedding] * n
    record = SpeakerRecord(
        user_id=user_id,
        embedding=verification_service._build_reference_embedding(samples),
        sample_embeddings=samples,
        enrolled_at=datetime.now(timezone.utc),
        sample_count=n,
    )
    verification_service.store.put_speaker(record)
    return record


# ---------------------------------------------------------------------
# GET /users/embeddings
# ---------------------------------------------------------------------


def test_users_embeddings_empty_returns_empty_list(client: TestClient):
    response = client.get("/users/embeddings")
    assert response.status_code == 200
    assert response.json() == []


def test_users_embeddings_returns_centroid_and_per_sample_vectors(
    client: TestClient,
    verification_service: VerificationService,
):
    _seed(verification_service, "alice", make_wav(2.0, waveform="noise", seed=11))
    _seed(verification_service, "bob", make_wav(2.0, waveform="noise", seed=22), n=4)

    response = client.get("/users/embeddings")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    by_id = {row["user_id"]: row for row in body}

    alice = by_id["alice"]
    assert len(alice["centroid"]) == HashEncoder.DIM
    assert len(alice["samples"]) == 3
    for sample in alice["samples"]:
        assert len(sample) == HashEncoder.DIM
    assert alice["sample_count"] == 3
    assert "enrolled_at" in alice

    assert by_id["bob"]["sample_count"] == 4
    assert len(by_id["bob"]["samples"]) == 4


def test_users_embeddings_does_not_leak_pii_columns(
    client: TestClient,
    verification_service: VerificationService,
):
    _seed(verification_service, "alice", make_wav(2.0, waveform="noise", seed=7))
    body = client.get("/users/embeddings").json()
    fields = set(body[0].keys())
    # Schema is intentionally narrow — no metadata leakage from
    # SpeakerRecord into the API surface.
    assert fields == {"user_id", "centroid", "samples", "sample_count", "enrolled_at"}


# ---------------------------------------------------------------------
# POST /embed
# ---------------------------------------------------------------------


def test_embed_returns_unit_length_vector_and_provenance(
    client: TestClient,
    verification_service: VerificationService,
):
    wav = make_wav(2.0, frequency=220.0)
    response = client.post(
        "/embed",
        files={"audio": ("preview.wav", wav, "audio/wav")},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["embedding"]) == HashEncoder.DIM
    assert all(isinstance(v, (int, float)) for v in body["embedding"])
    assert body["frame_count"] > 0
    assert body["duration_ms"] > 0
    assert isinstance(body["snr_db"], (int, float))
    # Provenance structure must be present (HashEncoder lacks the
    # `provenance` attribute → falls back to "redimnet_b5" via getattr).
    assert body["model_provenance"] is not None
    assert "encoder" in body["model_provenance"]
    assert "is_degraded" in body["model_provenance"]


def test_embed_does_not_persist_a_verification_row(
    client: TestClient,
    verification_service: VerificationService,
):
    before = len(verification_service.store.list_results())
    client.post(
        "/embed",
        files={"audio": ("preview.wav", make_wav(2.0, frequency=220.0), "audio/wav")},
    )
    after = len(verification_service.store.list_results())
    assert before == after, "POST /embed must not write to the verification log"


def test_embed_400_on_empty_payload(client: TestClient):
    response = client.post(
        "/embed",
        files={"audio": ("empty.wav", b"", "audio/wav")},
    )
    assert response.status_code == 400


def test_embed_400_on_silent_audio(client: TestClient):
    # All-zero PCM → trim_to_voice raises NoSpeechDetectedError → 400.
    silent = make_wav(2.0, frequency=220.0, amplitude=0.0)
    response = client.post(
        "/embed",
        files={"audio": ("silent.wav", silent, "audio/wav")},
    )
    assert response.status_code == 400


def test_embed_matches_enrolment_embedding_for_same_audio(
    client: TestClient,
    verification_service: VerificationService,
):
    """The encoder-only path must produce the same vector that
    enrolment would store — otherwise the live point and the cluster
    centres live in different spaces and the visualisation lies."""
    wav = make_wav(2.0, frequency=220.0)
    response = client.post(
        "/embed",
        files={"audio": ("preview.wav", wav, "audio/wav")},
    )
    embed_vec = response.json()["embedding"]

    # Reference path: same trim + same encoder call as enrol().
    payload = verification_service.audio.decode_wav(wav)
    trimmed, _ = verification_service.audio.trim_to_voice(payload)
    reference_vec = verification_service.encoder.embed(trimmed.waveform)

    assert len(embed_vec) == len(reference_vec)
    for a, b in zip(embed_vec, reference_vec):
        assert abs(a - b) < 1e-6
