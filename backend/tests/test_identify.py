"""POST /identify — open-set "most similar" route.

Returns a ranked top-N over every enrolled centroid given an arbitrary
input WAV. No user_id required from the caller."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from datetime import datetime, timezone

from app.api import dependencies, routes
from app.models import SpeakerRecord
from app.services.verification import VerificationService

from .conftest import make_wav


def _seed_speaker(verification_service: VerificationService, user_id: str, wav_bytes: bytes, n_samples: int = 3):
    """Write a SpeakerRecord directly into the store, bypassing the
    enrolment SNR gate. Uses the real encoder so the embedding is the
    one /identify will compute against."""
    payload = verification_service.audio.decode_wav(wav_bytes)
    trimmed, _ = verification_service.audio.trim_to_voice(payload)
    embedding = verification_service.encoder.embed(trimmed.waveform)
    samples = [embedding] * n_samples
    record = SpeakerRecord(
        user_id=user_id,
        embedding=verification_service._build_reference_embedding(samples),
        sample_embeddings=samples,
        enrolled_at=datetime.now(timezone.utc),
        sample_count=n_samples,
    )
    verification_service.store.put_speaker(record)


@pytest.fixture
def client(verification_service: VerificationService) -> TestClient:
    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification_service
    app.include_router(routes.router)
    return TestClient(app)


# -----------------------------------------------------------------------------
# Service-level tests (use the VerificationService directly)
# -----------------------------------------------------------------------------


def _user_wav(seed: int) -> bytes:
    """Per-user pseudo-random noise — produces distinguishable
    HashEncoder embeddings since the byte content differs per seed.
    Doesn't pass the SNR gate (pure noise has no signal/noise
    distinction), so use _seed_speaker() to install directly."""
    return make_wav(2.0, waveform="noise", seed=seed)


def test_identify_returns_top_n_sorted_descending(verification_service: VerificationService):
    """Enrol three speakers with distinct seeded waveforms; identifying
    with alice's exact waveform should rank alice first."""
    waveforms = {"alice": _user_wav(seed=11), "bob": _user_wav(seed=22), "carol": _user_wav(seed=33)}
    for user_id, wav in waveforms.items():
        _seed_speaker(verification_service, user_id, wav)

    # Query with the SAME bytes alice was enrolled with → top match.
    # We have to feed audio that passes the trim_to_voice gate; the
    # real-enrolment path stamped each speaker via the same trimmed
    # waveform, so the query's resulting embedding will be identical.
    result = verification_service.identify(audio_bytes=waveforms["alice"], top_n=3)

    assert len(result.matches) == 3
    assert result.matches[0].user_id == "alice"
    sims = [m.similarity_score for m in result.matches]
    assert sims == sorted(sims, reverse=True)
    assert result.n_enrolled_total == 3


def test_identify_top_n_caps_at_enrolled_count(verification_service: VerificationService):
    """top_n=10 against 2 enrolled speakers returns 2 matches, not 10."""
    for user_id, seed in (("alice", 11), ("bob", 22)):
        _seed_speaker(verification_service, user_id, _user_wav(seed))

    result = verification_service.identify(audio_bytes=_user_wav(seed=11), top_n=10)
    assert len(result.matches) == 2


def test_identify_includes_thresholds_and_would_accept(verification_service: VerificationService, enrolled_user):
    """Response carries the configured thresholds + the would_accept_top1
    bit so the UI can colour-code the top match without re-deriving."""
    user_id, wav = enrolled_user
    result = verification_service.identify(audio_bytes=wav, top_n=3)

    assert result.similarity_threshold == 0.75
    assert result.deepfake_threshold == 0.5
    assert result.matches[0].user_id == user_id
    assert result.would_accept_top1 is True


def test_identify_raises_when_no_users_enrolled(verification_service: VerificationService):
    with pytest.raises(RuntimeError, match="No users enrolled"):
        verification_service.identify(audio_bytes=make_wav(2.0))


# -----------------------------------------------------------------------------
# Route-level tests
# -----------------------------------------------------------------------------


def test_identify_route_200_with_ranked_matches(client: TestClient, enrolled_user):
    user_id, wav = enrolled_user
    resp = client.post(
        "/identify",
        files={"audio": ("query.wav", wav, "audio/wav")},
        data={"top_n": "3"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "matches" in body
    assert len(body["matches"]) >= 1
    assert body["matches"][0]["user_id"] == user_id
    assert body["matches"][0]["similarity_score"] > 0.5
    assert body["similarity_threshold"] == 0.75
    assert body["deepfake_threshold"] == 0.5
    assert body["n_enrolled_total"] == 1


def test_identify_route_default_top_n_is_3(client: TestClient, verification_service: VerificationService):
    """Without explicit top_n, the route returns up to 3 matches."""
    for user_id, seed in (("alice", 11), ("bob", 22), ("carol", 33), ("dave", 44)):
        _seed_speaker(verification_service, user_id, _user_wav(seed))

    resp = client.post(
        "/identify",
        files={"audio": ("query.wav", _user_wav(seed=11), "audio/wav")},
    )
    assert resp.status_code == 200
    assert len(resp.json()["matches"]) == 3


def test_identify_route_404_when_no_users_enrolled(client: TestClient):
    resp = client.post(
        "/identify",
        files={"audio": ("query.wav", make_wav(2.0), "audio/wav")},
    )
    assert resp.status_code == 404
    assert "no users enrolled" in resp.json()["detail"].lower()


def test_identify_route_400_on_empty_audio(client: TestClient, enrolled_user):
    resp = client.post(
        "/identify",
        files={"audio": ("empty.wav", b"", "audio/wav")},
    )
    assert resp.status_code == 400
    assert "empty" in resp.json()["detail"].lower()


def test_identify_route_does_not_require_authentication(client: TestClient, enrolled_user):
    """No cookie / no auth header / no body field beyond audio."""
    _, wav = enrolled_user
    resp = client.post(
        "/identify",
        files={"audio": ("clip.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 200
