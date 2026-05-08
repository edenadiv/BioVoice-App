"""Enrollment and verification orchestration."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from statistics import fmean
from typing import Protocol
from uuid import uuid4

from app.models import SpeakerRecord, VerificationRecord
from app.schemas import EnrollmentResponse, SpeakerResponse, VerificationResponse
from app.services.audio import AudioService
from app.services.detector import DeepfakeDetectorService


class VerificationStore(Protocol):
    def put_speaker(self, record: SpeakerRecord) -> None: ...

    def get_speaker(self, user_id: str) -> SpeakerRecord | None: ...

    def list_users(self) -> list[SpeakerRecord]: ...

    def add_result(self, record: VerificationRecord) -> None: ...

    def list_results(self) -> list[VerificationRecord]: ...


class SpeakerEmbeddingService:
    """Temporary feature-based embedding service.

    This provides a deterministic placeholder until the speaker encoder is ported
    into the web backend.
    """

    def embed(self, waveform: list[float]) -> list[float]:
        if not waveform:
            return [0.0] * 8

        mean = fmean(waveform)
        centered = [sample - mean for sample in waveform]
        rms = math.sqrt(fmean(sample * sample for sample in centered))
        peak = max(abs(sample) for sample in waveform)
        zero_crossings = self._zero_crossing_rate(centered)
        spread = self._spread(centered)
        first_moment = fmean(abs(sample) for sample in centered)
        energy_proxy = fmean(abs(cur - prev) for prev, cur in zip(centered, centered[1:])) if len(centered) > 1 else 0.0
        return [
            mean,
            spread,
            rms,
            peak,
            first_moment,
            self._percentile(centered, 0.25),
            self._percentile(centered, 0.75),
            zero_crossings + energy_proxy,
        ]

    @staticmethod
    def cosine_similarity(a: list[float], b: list[float]) -> float:
        dot = sum(x * y for x, y in zip(a, b))
        norm_a = math.sqrt(sum(x * x for x in a))
        norm_b = math.sqrt(sum(y * y for y in b))
        denom = norm_a * norm_b
        if denom <= 1e-8:
            return 0.0
        score = dot / denom
        return (score + 1.0) / 2.0

    @staticmethod
    def _zero_crossing_rate(waveform: list[float]) -> float:
        if len(waveform) < 2:
            return 0.0
        crossings = sum(
            1
            for left, right in zip(waveform, waveform[1:])
            if (left >= 0 > right) or (left < 0 <= right)
        )
        return crossings / (len(waveform) - 1)

    @staticmethod
    def _spread(waveform: list[float]) -> float:
        if len(waveform) < 2:
            return 0.0
        mean = fmean(waveform)
        variance = fmean((sample - mean) ** 2 for sample in waveform)
        return math.sqrt(variance)

    @staticmethod
    def _percentile(values: list[float], percentile: float) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        if len(ordered) == 1:
            return ordered[0]
        index = percentile * (len(ordered) - 1)
        lower = math.floor(index)
        upper = math.ceil(index)
        if lower == upper:
            return ordered[int(index)]
        fraction = index - lower
        return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


class VerificationService:
    def __init__(
        self,
        store: VerificationStore,
        detector: DeepfakeDetectorService,
        sample_rate: int,
        similarity_threshold: float,
        deepfake_threshold: float,
        min_enrollment_samples: int,
    ):
        self.store = store
        self.detector = detector
        self.sample_rate = sample_rate
        self.similarity_threshold = similarity_threshold
        self.deepfake_threshold = deepfake_threshold
        self.min_enrollment_samples = min_enrollment_samples
        self.audio = AudioService(target_sample_rate=sample_rate)
        self.encoder = SpeakerEmbeddingService()

    def list_users(self) -> list[SpeakerResponse]:
        return [
            SpeakerResponse(
                user_id=record.user_id,
                enrolled_at=record.enrolled_at,
                sample_count=record.sample_count,
            )
            for record in self.store.list_users()
        ]

    def enroll(self, user_id: str, audio_bytes: bytes, filename: str | None = None) -> EnrollmentResponse:
        payload = self.audio.decode_wav(audio_bytes)
        embedding = self.encoder.embed(payload.waveform)
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

        payload = self.audio.decode_wav(audio_bytes)
        query_embedding = self.encoder.embed(payload.waveform)
        deepfake_score = self.detector.detect(payload.waveform)
        sample_similarities = [
            self.encoder.cosine_similarity(sample_embedding, query_embedding)
            for sample_embedding in speaker.sample_embeddings
        ]
        centroid_similarity = self.encoder.cosine_similarity(speaker.embedding, query_embedding)
        similarity_score = self._aggregate_similarity(sample_similarities, centroid_similarity)

        if deepfake_score < self.deepfake_threshold:
            decision = "DEEPFAKE"
            message = "Audio was flagged as synthetic or manipulated before speaker matching."
        elif similarity_score >= self.similarity_threshold:
            decision = "ACCEPT"
            message = "Speaker identity matched the enrolled profile."
        else:
            decision = "REJECT"
            message = "Audio was genuine enough, but the speaker did not match."

        record = VerificationRecord(
            result_id=str(uuid4()),
            user_id=user_id,
            decision=decision,
            similarity_score=similarity_score,
            deepfake_score=deepfake_score,
            message=message,
            created_at=datetime.now(timezone.utc),
            metadata={
                "filename": filename,
                "centroid_similarity": centroid_similarity,
                "sample_similarities": sample_similarities,
            },
        )
        self.store.add_result(record)
        return VerificationResponse(
            result_id=record.result_id,
            user_id=user_id,
            decision=decision,
            similarity_score=similarity_score,
            deepfake_score=deepfake_score,
            centroid_similarity=centroid_similarity,
            sample_similarities=sample_similarities,
            message=message,
            created_at=record.created_at,
        )

    def list_results(self) -> list[VerificationResponse]:
        return [
            VerificationResponse(
                result_id=result.result_id,
                user_id=result.user_id,
                decision=result.decision,
                similarity_score=result.similarity_score,
                deepfake_score=result.deepfake_score,
                centroid_similarity=float((result.metadata or {}).get("centroid_similarity", result.similarity_score)),
                sample_similarities=list((result.metadata or {}).get("sample_similarities", [])),
                message=result.message,
                created_at=result.created_at,
            )
            for result in self.store.list_results()
        ]

    def _build_reference_embedding(self, sample_embeddings: list[list[float]]) -> list[float]:
        normalized_samples = [self._normalize_embedding(embedding) for embedding in sample_embeddings if embedding]
        if not normalized_samples:
            return [0.0] * 8

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
