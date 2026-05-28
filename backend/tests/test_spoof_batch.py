"""POST /spoof/batch — generate many clones against a target, keep only
the ones that resemble the target. Hermetic: a sequence-returning spoof
stub + HashEncoder/StubDetector/MemoryStore (no XTTS, no model weights)."""

from __future__ import annotations

import base64

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes
from app.services.spoof import SpoofGenerationResult
from app.services.verification import VerificationService
from app.storage.memory_store import MemoryStore

from .conftest import HashEncoder, SAMPLE_RATE, StubDetector, make_wav

# Audio whose HashEncoder embedding matches the enrolled sine centroid vs not.
MATCH_WAV = make_wav(2.0, frequency=220.0)
NOMATCH_WAV = make_wav(2.0, waveform="noise", amplitude=0.6, seed=42)


class _SeqSpoofService:
    """Returns a fixed sequence of WAV blobs across successive generate()
    calls so a test can control which candidates match the target."""

    def __init__(self, blobs: list[bytes]):
        self.blobs = blobs
        self.calls = 0

    def generate(self, **kwargs) -> SpoofGenerationResult:
        blob = self.blobs[self.calls % len(self.blobs)]
        self.calls += 1
        return SpoofGenerationResult(
            audio_bytes=blob,
            file_name=f"cand_{self.calls}.wav",
            source_description="stub",
            engine_id="stub",
            voice_id=None,
        )


def _build_app(blobs: list[bytes]):
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
    spoof = _SeqSpoofService(blobs)
    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_spoof_generation_service] = lambda: spoof
    app.include_router(routes.router)
    return TestClient(app, base_url="https://testserver"), verification


def _enroll_alice(verification: VerificationService) -> None:
    for _ in range(3):
        verification.enroll(user_id="alice", audio_bytes=MATCH_WAV, filename="e.wav")


def test_batch_keeps_matches_discards_others():
    client, verification = _build_app([MATCH_WAV, NOMATCH_WAV, MATCH_WAV, NOMATCH_WAV])
    _enroll_alice(verification)

    resp = client.post(
        "/spoof/batch",
        json={"target_user_id": "alice", "texts": ["transfer the funds"],
              "candidates_per_text": 4, "engine": "stub"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["requested"] == 4
    assert body["generated"] == 4
    assert body["kept"] == 2
    # sorted by similarity desc -> kept ones first
    sims = [c["similarity_to_target"] for c in body["candidates"]]
    assert sims == sorted(sims, reverse=True)
    kept = [c for c in body["candidates"] if c["kept"]]
    discarded = [c for c in body["candidates"] if not c["kept"]]
    assert len(kept) == 2 and len(discarded) == 2
    for c in kept:
        assert c["similarity_to_target"] >= 0.75
        assert c["audio_b64"] is not None
        # base64 round-trips to a non-empty WAV
        assert base64.b64decode(c["audio_b64"]) == MATCH_WAV
    for c in discarded:
        assert c["similarity_to_target"] < 0.75
        assert c["audio_b64"] is None


def test_batch_runs_aasist_by_default_and_can_skip():
    client, verification = _build_app([MATCH_WAV])
    _enroll_alice(verification)

    on = client.post("/spoof/batch", json={
        "target_user_id": "alice", "texts": ["x"], "candidates_per_text": 1, "engine": "stub",
    }).json()
    assert on["candidates"][0]["deepfake_score"] is not None
    assert on["candidates"][0]["decision"] == "GENUINE"  # StubDetector 0.9 >= 0.5

    client2, verification2 = _build_app([MATCH_WAV])
    _enroll_alice(verification2)
    off = client2.post("/spoof/batch", json={
        "target_user_id": "alice", "texts": ["x"], "candidates_per_text": 1,
        "engine": "stub", "run_aasist": False,
    }).json()
    assert off["candidates"][0]["deepfake_score"] is None
    assert off["candidates"][0]["decision"] is None


def test_batch_custom_keep_threshold_keeps_all():
    client, verification = _build_app([MATCH_WAV, NOMATCH_WAV])
    _enroll_alice(verification)
    body = client.post("/spoof/batch", json={
        "target_user_id": "alice", "texts": ["x"], "candidates_per_text": 2,
        "engine": "stub", "keep_threshold": 0.0,
    }).json()
    assert body["kept"] == 2
    assert body["keep_threshold"] == 0.0


def test_batch_404_when_target_not_enrolled():
    client, _ = _build_app([MATCH_WAV])
    resp = client.post("/spoof/batch", json={
        "target_user_id": "ghost", "texts": ["x"], "candidates_per_text": 1, "engine": "stub",
    })
    assert resp.status_code == 404


def test_batch_rejects_oversized_request():
    client, verification = _build_app([MATCH_WAV])
    _enroll_alice(verification)
    resp = client.post("/spoof/batch", json={
        "target_user_id": "alice", "texts": [f"t{i}" for i in range(65)],
        "candidates_per_text": 1, "engine": "stub",
    })
    assert resp.status_code == 400
    assert "too large" in resp.json()["detail"].lower()
