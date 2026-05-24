"""End-to-end tests for the verification service.

Covers the SDD §2.5 decision logic: ACCEPT when both similarity and authenticity
clear their thresholds; DEEPFAKE when authenticity fails (regardless of similarity);
REJECT when similarity fails but authenticity passes.
"""

from __future__ import annotations

import re

import pytest

from app.services.verification import VerificationService

from .conftest import make_wav


def test_accept_when_same_voice_and_genuine(verification_service, enrolled_user, detector):
    user_id, wav = enrolled_user
    detector.score = 0.9  # genuine

    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    assert result.decision == "ACCEPT"
    assert result.decision_reason == "accepted"
    assert result.message == "Identity verified."
    assert result.similarity_score >= 0.75
    assert result.deepfake_score >= 0.5


def test_reject_when_different_voice(verification_service, enrolled_user, detector):
    user_id, _ = enrolled_user
    detector.score = 0.9  # still genuine, but different speaker
    different = make_wav(2.0, waveform="noise", amplitude=0.6, seed=42)

    result = verification_service.verify(user_id=user_id, audio_bytes=different)

    assert result.decision == "REJECT"
    assert result.decision_reason == "mismatch"
    assert result.message == "Speaker did not match the enrolled profile."
    assert result.deepfake_score >= 0.5


def test_deepfake_short_circuits_before_similarity(verification_service, enrolled_user, detector):
    user_id, wav = enrolled_user
    detector.score = 0.1  # synthetic

    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    assert result.decision == "DEEPFAKE"
    assert result.decision_reason == "synthetic"
    assert result.message == "Audio flagged as synthetic. Access denied."


def test_deepfake_check_runs_first_per_sdd(verification_service, enrolled_user, detector):
    """Even matching speaker audio is rejected if it is flagged as synthetic.

    Per SDD §2.5 / Fig. 13, AASIST runs before similarity in the decision tree.
    """
    user_id, wav = enrolled_user
    detector.score = 0.05  # well below threshold

    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    assert result.decision == "DEEPFAKE"
    assert result.decision_reason == "synthetic"


def test_session_id_format(verification_service, enrolled_user, detector):
    user_id, wav = enrolled_user
    detector.score = 0.9

    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    # F2.3 — VRF-YYYYMMDD-NNNNN with a 5-digit zero-padded daily counter.
    assert re.match(r"^VRF-\d{8}-\d{5}$", result.session_id), result.session_id


def test_stage_breakdown_populated(verification_service, enrolled_user, detector):
    user_id, wav = enrolled_user
    detector.score = 0.9

    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    breakdown = result.stage_breakdown
    assert breakdown.load_ms >= 0.0
    assert breakdown.resample_ms >= 0.0
    assert breakdown.normalize_ms >= 0.0
    assert breakdown.embed_ms > 0.0
    assert breakdown.detect_ms >= 0.0
    assert breakdown.total_ms >= breakdown.embed_ms


def test_analysis_details_populated(verification_service, enrolled_user, detector):
    """Placeholder derivation lives until Yoav's Y-8."""
    user_id, wav = enrolled_user
    detector.score = 0.92

    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    assert result.analysis_details is not None
    assert 0.0 <= result.analysis_details.voice_naturalness <= 1.0
    assert 0.0 <= result.analysis_details.artifact_detection <= 1.0


def test_verify_returns_speaker_model_scores(verification_service, enrolled_user, detector):
    user_id, wav = enrolled_user
    detector.score = 0.9

    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    assert len(result.speaker_model_scores) == 1
    score = result.speaker_model_scores[0]
    assert score.model_key == "redimnet_b5"
    assert score.drives_decision is True
    assert score.similarity_score == pytest.approx(result.similarity_score)
    assert score.centroid_similarity == pytest.approx(result.centroid_similarity)


def test_verify_reports_comparison_model_scores(store, detector):
    class ComparisonEncoder:
        provenance = "ecapa_voxceleb"

        def embed(self, waveform: list[float]) -> list[float]:
            scale = sum(abs(sample) for sample in waveform) or 1.0
            return [scale, scale / 2]

        @staticmethod
        def cosine_similarity(a: list[float], b: list[float]) -> float:
            dot = sum(x * y for x, y in zip(a, b))
            norm_a = sum(x * x for x in a) ** 0.5
            norm_b = sum(y * y for y in b) ** 0.5
            return (dot / max(norm_a * norm_b, 1e-8) + 1.0) / 2.0

    service = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=ComparisonEncoder(),
        sample_rate=16000,
        similarity_threshold=0.75,
        deepfake_threshold=0.5,
        min_enrollment_samples=3,
        comparison_encoders={"ecapa_voxceleb": ComparisonEncoder()},
    )
    wav = make_wav(2.0, frequency=220.0)
    for _ in range(3):
        service.enroll(user_id="alice", audio_bytes=wav, filename="alice.wav")

    result = service.verify(user_id="alice", audio_bytes=wav)

    keys = {score.model_key for score in result.speaker_model_scores}
    assert keys == {"redimnet_b5", "ecapa_voxceleb"}


def test_identify_reports_per_model_matches(store, detector):
    class ComparisonEncoder:
        provenance = "redimnet_b5"

        def embed(self, waveform: list[float]) -> list[float]:
            scale = sum(abs(sample) for sample in waveform) or 1.0
            return [scale, scale / 2]

        @staticmethod
        def cosine_similarity(a: list[float], b: list[float]) -> float:
            dot = sum(x * y for x, y in zip(a, b))
            norm_a = sum(x * x for x in a) ** 0.5
            norm_b = sum(y * y for y in b) ** 0.5
            return (dot / max(norm_a * norm_b, 1e-8) + 1.0) / 2.0

    service = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=ComparisonEncoder(),
        sample_rate=16000,
        similarity_threshold=0.75,
        deepfake_threshold=0.5,
        min_enrollment_samples=3,
        comparison_encoders={"ecapa_voxceleb": ComparisonEncoder()},
    )
    wav = make_wav(2.0, frequency=220.0)
    for _ in range(3):
        service.enroll(user_id="alice", audio_bytes=wav, filename="alice.wav")

    result = service.identify(audio_bytes=wav, top_n=3)

    assert result.speaker_model_matches
    assert result.speaker_model_matches[0].model_key == "redimnet_b5"
    assert result.speaker_model_matches[0].drives_decision is True
    assert result.speaker_model_matches[1].model_key == "ecapa_voxceleb"


def test_get_result_round_trip(verification_service, enrolled_user, detector):
    user_id, wav = enrolled_user
    detector.score = 0.9

    written = verification_service.verify(user_id=user_id, audio_bytes=wav)
    fetched = verification_service.get_result(user_id=user_id, result_id=written.result_id)

    assert fetched is not None
    assert fetched.result_id == written.result_id
    assert fetched.session_id == written.session_id
    assert fetched.decision == written.decision
    assert fetched.decision_reason == written.decision_reason
    assert fetched.stage_breakdown.total_ms == pytest.approx(written.stage_breakdown.total_ms)
    assert fetched.analysis_details is not None


def test_get_result_404_for_other_user(verification_service, enrolled_user, detector):
    user_id, wav = enrolled_user
    detector.score = 0.9
    result = verification_service.verify(user_id=user_id, audio_bytes=wav)

    fetched = verification_service.get_result(user_id="not-alice", result_id=result.result_id)

    assert fetched is None


def test_verify_unenrolled_user_raises(verification_service):
    with pytest.raises(ValueError):
        verification_service.verify(user_id="ghost", audio_bytes=make_wav(1.0))


def test_verify_under_enrolled_user_raises(verification_service, detector):
    detector.score = 0.9
    verification_service.enroll(user_id="bob", audio_bytes=make_wav(1.0), filename="x.wav")
    with pytest.raises(RuntimeError):
        verification_service.verify(user_id="bob", audio_bytes=make_wav(1.0))


def test_id_availability(verification_service, detector):
    assert verification_service.is_user_id_available("never-enrolled") is True
    detector.score = 0.9
    verification_service.enroll(user_id="taken", audio_bytes=make_wav(1.0), filename="x.wav")
    assert verification_service.is_user_id_available("taken") is False
