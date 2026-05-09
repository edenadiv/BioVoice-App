"""Enrollment and verification orchestration."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from statistics import fmean
from time import perf_counter
from typing import Protocol
from uuid import uuid4

from app.models import SpeakerRecord, VerificationRecord
from app.schemas import (
    AnalysisDetails,
    DecisionReason,
    EnrollmentResponse,
    SampleQuality,
    SpeakerResponse,
    StageBreakdown,
    VerificationResponse,
)
from app.services.audio import AudioService, SampleQualityRejectedError
from app.services.detector import DeepfakeDetectorService
from app.services.speaker_encoder import SpeakerEncoder
from app.services.sub_classifier import AcousticProbe


# Decision-logic alignment with SDD §2.5 / Fig. 13:
#   1. Preprocess audio
#   2. Extract embedding
#   3. Run AASIST → if deepfake_score < deepfake_threshold → reject as synthetic
#   4. Compute similarity → if < similarity_threshold → reject as mismatch
#   5. Accept


_ACCEPT_MESSAGE = "Identity verified."
_MISMATCH_MESSAGE = "Speaker did not match the enrolled profile."
_SYNTHETIC_MESSAGE = "Audio flagged as synthetic. Access denied."


class VerificationStore(Protocol):
    def put_speaker(self, record: SpeakerRecord) -> None: ...

    def get_speaker(self, user_id: str) -> SpeakerRecord | None: ...

    def list_users(self) -> list[SpeakerRecord]: ...

    def save_reference_sample(
        self,
        user_id: str,
        audio_bytes: bytes,
        original_filename: str,
        source: str,
    ) -> None: ...

    def add_result(self, record: VerificationRecord) -> None: ...

    def list_results(self) -> list[VerificationRecord]: ...

    def get_result(self, result_id: str) -> VerificationRecord | None: ...

    def next_verification_seq(self, day: str) -> int:
        """Atomic monotonic counter per day. `day` is a YYYYMMDD string.

        F2.3: backs the production-stable session-id `VRF-YYYYMMDD-NNNNN`.
        Returns 1 for the first call on a given day, 2 for the second, etc.
        Persists across restarts.
        """
        ...


class VerificationService:
    def __init__(
        self,
        store: VerificationStore,
        detector: DeepfakeDetectorService,
        speaker_encoder: SpeakerEncoder,
        sample_rate: int,
        similarity_threshold: float,
        deepfake_threshold: float,
        min_enrollment_samples: int,
        acoustic_probe: AcousticProbe | None = None,
    ):
        self.store = store
        self.detector = detector
        self.sample_rate = sample_rate
        self.similarity_threshold = similarity_threshold
        self.deepfake_threshold = deepfake_threshold
        self.min_enrollment_samples = min_enrollment_samples
        self.audio = AudioService(target_sample_rate=sample_rate)
        self.encoder = speaker_encoder
        # F4 — replaces the seeded-jitter `_derive_analysis_details`.
        # Heuristic mode by default; trained probe heads loaded if present.
        self.acoustic_probe = acoustic_probe or AcousticProbe()

    def list_users(self) -> list[SpeakerResponse]:
        return [
            SpeakerResponse(
                user_id=record.user_id,
                enrolled_at=record.enrolled_at,
                sample_count=record.sample_count,
            )
            for record in self.store.list_users()
        ]

    def is_user_id_available(self, user_id: str) -> bool:
        return self.store.get_speaker(user_id) is None

    def enroll(self, user_id: str, audio_bytes: bytes, filename: str | None = None) -> EnrollmentResponse:
        payload = self.audio.decode_wav(audio_bytes)
        # F3.3 — score the sample BEFORE trimming so noise estimates are
        # taken from the raw recording (post-trim there's no silence to
        # anchor SNR against). Reject low-quality samples here so they
        # never enter the centroid; the route layer maps the typed
        # exception to HTTP 400 + the operator-friendly explanation.
        quality = self.audio.score_quality(payload)
        if not quality.acceptable:
            raise SampleQualityRejectedError(quality.reason, quality)
        # F3.2 — trim silence before embedding so the centroid is built on
        # speech frames, not background noise. ValueError surfaces as 400
        # at the route layer with the operator-friendly message from
        # AudioService.trim_to_voice.
        trimmed, _ = self.audio.trim_to_voice(payload)
        embedding = self.encoder.embed(trimmed.waveform)
        existing = self.store.get_speaker(user_id)

        if existing is None:
            sample_embeddings = [embedding]
            record = SpeakerRecord(
                user_id=user_id,
                embedding=self._build_reference_embedding(sample_embeddings),
                sample_embeddings=sample_embeddings,
                enrolled_at=datetime.now(timezone.utc),
                sample_count=len(sample_embeddings),
            )
        else:
            sample_embeddings = [*existing.sample_embeddings, embedding]
            record = SpeakerRecord(
                user_id=user_id,
                embedding=self._build_reference_embedding(sample_embeddings),
                sample_embeddings=sample_embeddings,
                enrolled_at=existing.enrolled_at,
                sample_count=len(sample_embeddings),
            )

        self.store.put_speaker(record)
        self.store.save_reference_sample(
            user_id=user_id,
            audio_bytes=audio_bytes,
            original_filename=filename or f"{user_id}-enrollment.wav",
            source="enrollment",
        )
        remaining_samples = max(self.min_enrollment_samples - record.sample_count, 0)
        if remaining_samples > 0:
            message = (
                f"User '{user_id}' enrollment sample {record.sample_count}/{self.min_enrollment_samples} saved. "
                f"Collect {remaining_samples} more sample(s) before verification."
            )
        else:
            message = (
                f"User '{user_id}' enrolled successfully with {record.sample_count} sample(s). "
                "Verification is ready."
            )
        return EnrollmentResponse(
            user_id=user_id,
            status="enrolled",
            message=message,
            enrolled_at=record.enrolled_at,
            quality=SampleQuality(
                score=quality.score,
                snr_db=quality.snr_db,
                clipping_pct=quality.clipping_pct,
                speech_ratio=quality.speech_ratio,
                acceptable=quality.acceptable,
            ),
        )

    def verify(self, user_id: str, audio_bytes: bytes, filename: str | None = None) -> VerificationResponse:
        speaker = self.store.get_speaker(user_id)
        if speaker is None:
            raise ValueError(f"User '{user_id}' is not enrolled")
        if speaker.sample_count < self.min_enrollment_samples:
            raise RuntimeError(
                f"User '{user_id}' needs {self.min_enrollment_samples} enrollment samples before verification. "
                f"Current count: {speaker.sample_count}."
            )

        total_t0 = perf_counter()

        payload, audio_timings = self.audio.decode_wav_with_timings(audio_bytes)

        # F3.2 — strip leading/trailing silence so the embedding + spoof
        # detection both run on speech frames. trim_to_voice raises
        # ValueError if there's < 1 s of speech; the route layer maps that
        # to 400 with the user-facing message.
        trimmed, vad_ms = self.audio.trim_to_voice(payload)
        audio_timings.vad_ms = vad_ms

        t0 = perf_counter()
        query_embedding = self.encoder.embed(trimmed.waveform)
        embed_ms = (perf_counter() - t0) * 1000.0

        t0 = perf_counter()
        deepfake_score = self.detector.detect(trimmed.waveform)
        detect_ms = (perf_counter() - t0) * 1000.0

        sample_similarities = [
            self.encoder.cosine_similarity(sample_embedding, query_embedding)
            for sample_embedding in speaker.sample_embeddings
        ]
        centroid_similarity = self.encoder.cosine_similarity(speaker.embedding, query_embedding)
        similarity_score = self._aggregate_similarity(sample_similarities, centroid_similarity)

        decision, reason, message = self._decide(similarity_score, deepfake_score)
        # F4 — analysis details now come from acoustic features (HNR, F0
        # stability, spectral flatness) instead of perturbing the deepfake
        # score. Each axis varies with the actual recording's properties.
        analysis_details = self.acoustic_probe.score(
            trimmed.waveform, sample_rate=trimmed.sample_rate
        )

        total_ms = (perf_counter() - total_t0) * 1000.0
        stage_breakdown = StageBreakdown(
            load_ms=audio_timings.load_ms,
            resample_ms=audio_timings.resample_ms,
            normalize_ms=audio_timings.normalize_ms,
            vad_ms=audio_timings.vad_ms,
            embed_ms=embed_ms,
            detect_ms=detect_ms,
            total_ms=total_ms,
        )

        result_id = str(uuid4())
        created_at = datetime.now(timezone.utc)
        day_key = f"{created_at.year:04d}{created_at.month:02d}{created_at.day:02d}"
        seq = self.store.next_verification_seq(day_key)
        session_id = self._format_session_id(seq, created_at)

        record = VerificationRecord(
            result_id=result_id,
            user_id=user_id,
            decision=decision,
            similarity_score=similarity_score,
            deepfake_score=deepfake_score,
            message=message,
            created_at=created_at,
            metadata={
                "filename": filename,
                "centroid_similarity": centroid_similarity,
                "sample_similarities": sample_similarities,
                "decision_reason": reason,
                "session_id": session_id,
                "stage_breakdown": stage_breakdown.model_dump(),
                "analysis_details": analysis_details.model_dump() if analysis_details else None,
            },
        )
        self.store.add_result(record)

        return VerificationResponse(
            result_id=record.result_id,
            user_id=user_id,
            decision=decision,
            decision_reason=reason,
            similarity_score=similarity_score,
            deepfake_score=deepfake_score,
            centroid_similarity=centroid_similarity,
            sample_similarities=sample_similarities,
            message=message,
            session_id=session_id,
            stage_breakdown=stage_breakdown,
            analysis_details=analysis_details,
            created_at=created_at,
        )

    def get_result(self, user_id: str, result_id: str) -> VerificationResponse | None:
        record = self.store.get_result(result_id)
        if record is None or record.user_id != user_id:
            return None
        return self._record_to_response(record)

    def list_results(self) -> list[VerificationResponse]:
        return [self._record_to_response(record) for record in self.store.list_results()]

    def _decide(
        self, similarity_score: float, deepfake_score: float
    ) -> tuple[str, DecisionReason, str]:
        if deepfake_score < self.deepfake_threshold:
            return "DEEPFAKE", "synthetic", _SYNTHETIC_MESSAGE
        if similarity_score >= self.similarity_threshold:
            return "ACCEPT", "accepted", _ACCEPT_MESSAGE
        return "REJECT", "mismatch", _MISMATCH_MESSAGE

    def _record_to_response(self, record: VerificationRecord) -> VerificationResponse:
        meta = record.metadata or {}
        analysis_dict = meta.get("analysis_details")
        analysis_details = AnalysisDetails.model_validate(analysis_dict) if analysis_dict else None
        stage_dict = meta.get("stage_breakdown") or {}
        stage_breakdown = StageBreakdown.model_validate(stage_dict)
        reason = meta.get("decision_reason") or self._reason_from_decision(record.decision)
        # Old records persist their session_id in metadata; for legacy rows
        # without one we synthesise a stable suffix from the result_id rather
        # than burning a fresh counter (counter increments only on write).
        session_id = meta.get("session_id") or self._legacy_session_id(record.result_id, record.created_at)

        return VerificationResponse(
            result_id=record.result_id,
            user_id=record.user_id,
            decision=record.decision,
            decision_reason=reason,
            similarity_score=record.similarity_score,
            deepfake_score=record.deepfake_score,
            centroid_similarity=float(meta.get("centroid_similarity", record.similarity_score)),
            sample_similarities=list(meta.get("sample_similarities", [])),
            message=record.message,
            session_id=session_id,
            stage_breakdown=stage_breakdown,
            analysis_details=analysis_details,
            created_at=record.created_at,
        )

    @staticmethod
    def _reason_from_decision(decision: str) -> DecisionReason:
        if decision == "ACCEPT":
            return "accepted"
        if decision == "DEEPFAKE":
            return "synthetic"
        return "mismatch"

    # `_derive_analysis_details` removed in F4 — replaced by `AcousticProbe`
    # which computes the four axes from real acoustic features. See
    # `app/services/sub_classifier.py` and `docs/paper/sub_classifier.md`.

    @staticmethod
    def _format_session_id(seq: int, created_at: datetime) -> str:
        """F2.3 — VRF-YYYYMMDD-NNNNN with a 5-digit zero-padded daily counter."""
        return (
            f"VRF-{created_at.year:04d}{created_at.month:02d}{created_at.day:02d}"
            f"-{seq:05d}"
        )

    @staticmethod
    def _legacy_session_id(result_id: str, created_at: datetime) -> str:
        """Pre-F2.3 format reconstructor for historical rows without a stored
        session_id. Reads as `VRF-YYYY-MMDD-XXXX` (last 4 of result_id)."""
        suffix = result_id.replace("-", "").upper()[-4:].rjust(4, "0")
        return f"VRF-{created_at.year:04d}-{created_at.month:02d}{created_at.day:02d}-{suffix}"

    def _build_reference_embedding(self, sample_embeddings: list[list[float]]) -> list[float]:
        normalized_samples = [self._normalize_embedding(embedding) for embedding in sample_embeddings if embedding]
        if not normalized_samples:
            return []

        dimensions = len(normalized_samples[0])
        averaged = [
            fmean(sample[index] for sample in normalized_samples)
            for index in range(dimensions)
        ]
        return self._normalize_embedding(averaged)

    def _aggregate_similarity(self, sample_similarities: list[float], centroid_similarity: float) -> float:
        if not sample_similarities:
            return centroid_similarity

        ranked = sorted(sample_similarities, reverse=True)
        top_k = ranked[: min(2, len(ranked))]
        sample_score = fmean(top_k)
        return (sample_score + centroid_similarity) / 2.0

    @staticmethod
    def _normalize_embedding(embedding: list[float]) -> list[float]:
        norm = math.sqrt(sum(value * value for value in embedding))
        if norm <= 1e-8:
            return [0.0 for _ in embedding]
        return [value / norm for value in embedding]
