"""Enrollment and verification orchestration."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from pathlib import Path
from statistics import fmean
from time import perf_counter
from typing import Protocol
from uuid import uuid4

from app.models import SpeakerRecord, VerificationRecord
from app.schemas import (
    AnalysisDetails,
    DecisionReason,
    EmbedResponse,
    EnrollmentResponse,
    IdentificationMatch,
    IdentificationResponse,
    ModelProvenance,
    SampleQuality,
    SpeakerFusionDecision,
    SpeakerModelMatches,
    SpeakerModelScore,
    SpeakerResponse,
    StageBreakdown,
    UserEmbedding,
    VerificationResponse,
    SpeakerModelKey,
)
from app.services.audio import AudioService, SampleQualityRejectedError
from app.services.detector import DeepfakeDetectorService
from app.services.speaker_encoder import SpeakerEncoder
from app.services.sub_classifier import AcousticProbe


_ACCEPT_MESSAGE = "Identity verified."
_MISMATCH_MESSAGE = "Speaker did not match the enrolled profile."
_SYNTHETIC_MESSAGE = "Audio flagged as synthetic. Access denied."


def _clamp_unit(value: float) -> float:
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return value


class VerificationStore(Protocol):
    def put_speaker(self, record: SpeakerRecord) -> None: ...
    def get_speaker(self, user_id: str) -> SpeakerRecord | None: ...
    def list_users(self) -> list[SpeakerRecord]: ...
    def save_reference_sample(self, user_id: str, audio_bytes: bytes, original_filename: str, source: str) -> None: ...
    def list_reference_samples(self, user_id: str) -> list: ...
    def add_result(self, record: VerificationRecord) -> None: ...
    def list_results(self) -> list[VerificationRecord]: ...
    def get_result(self, result_id: str) -> VerificationRecord | None: ...
    def next_verification_seq(self, day: str) -> int: ...


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
        comparison_encoders: dict[str, SpeakerEncoder] | None = None,
        model_similarity_thresholds: dict[str, float] | None = None,
    ):
        self.store = store
        self.detector = detector
        self.sample_rate = sample_rate
        self.similarity_threshold = similarity_threshold
        self.model_similarity_thresholds = {
            "redimnet_b5": similarity_threshold,
            **(model_similarity_thresholds or {}),
        }
        self.deepfake_threshold = deepfake_threshold
        self.min_enrollment_samples = min_enrollment_samples
        self.audio = AudioService(target_sample_rate=sample_rate)
        self.encoder = speaker_encoder
        self.comparison_encoders = dict(comparison_encoders or {})
        self.acoustic_probe = acoustic_probe or AcousticProbe()

    def _collect_provenance(self) -> ModelProvenance:
        encoder_provenance = getattr(self.encoder, "provenance", "redimnet_b5")
        detector_provenance = getattr(self.detector, "provenance", "aasist")
        probe_provenance = getattr(self.acoustic_probe, "provenance", "heuristic")
        is_degraded = (
            encoder_provenance == "heuristic_placeholder"
            or detector_provenance != "aasist"
        )
        return ModelProvenance(
            encoder=encoder_provenance,
            detector=detector_provenance,
            acoustic_probe=probe_provenance,
            is_degraded=is_degraded,
        )

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

    def list_user_embeddings(self, model_key: SpeakerModelKey = "redimnet_b5") -> list[UserEmbedding]:
        rows: list[UserEmbedding] = []
        for record in self.store.list_users():
            hydrated = self._ensure_comparison_embeddings(record)
            centroid, samples = self._embeddings_for_model(hydrated, model_key)
            rows.append(
                UserEmbedding(
                    user_id=hydrated.user_id,
                    model_key=model_key,
                    centroid=centroid,
                    samples=samples,
                    sample_count=hydrated.sample_count,
                    enrolled_at=hydrated.enrolled_at,
                )
            )
        return rows

    def embed_only(self, audio_bytes: bytes, model_key: SpeakerModelKey = "redimnet_b5") -> EmbedResponse:
        decoded = self.audio.decode_wav(audio_bytes)
        quality = self.audio.score_quality(decoded)
        trimmed, _ = self.audio.trim_to_voice(decoded)
        encoder = self._encoder_for_model(model_key)
        embedding = encoder.embed(trimmed.waveform)
        duration_ms = len(trimmed.waveform) / max(1, trimmed.sample_rate) * 1000.0
        return EmbedResponse(
            model_key=model_key,
            embedding=embedding,
            duration_ms=duration_ms,
            snr_db=quality.snr_db,
            frame_count=len(trimmed.waveform),
            model_provenance=self._collect_provenance(),
        )

    def enroll(self, user_id: str, audio_bytes: bytes, filename: str | None = None) -> EnrollmentResponse:
        payload = self.audio.decode_wav(audio_bytes)
        quality = self.audio.score_quality(payload)
        if not quality.acceptable:
            raise SampleQualityRejectedError(quality.reason, quality)
        trimmed, _ = self.audio.trim_to_voice(payload)
        embedding = self.encoder.embed(trimmed.waveform)
        comparison_embedding_updates = self._build_comparison_sample_embeddings(trimmed.waveform)
        existing = self.store.get_speaker(user_id)

        if existing is None:
            sample_embeddings = [embedding]
            record = SpeakerRecord(
                user_id=user_id,
                embedding=self._build_reference_embedding(sample_embeddings),
                sample_embeddings=sample_embeddings,
                comparison_embeddings={
                    model_key: self._build_reference_embedding([model_embedding])
                    for model_key, model_embedding in comparison_embedding_updates.items()
                },
                comparison_sample_embeddings={
                    model_key: [model_embedding]
                    for model_key, model_embedding in comparison_embedding_updates.items()
                },
                enrolled_at=datetime.now(timezone.utc),
                sample_count=len(sample_embeddings),
            )
        else:
            sample_embeddings = [*existing.sample_embeddings, embedding]
            comparison_sample_embeddings = {
                model_key: list(model_embeddings)
                for model_key, model_embeddings in existing.comparison_sample_embeddings.items()
            }
            for model_key, model_embedding in comparison_embedding_updates.items():
                comparison_sample_embeddings.setdefault(model_key, []).append(model_embedding)
            record = SpeakerRecord(
                user_id=user_id,
                embedding=self._build_reference_embedding(sample_embeddings),
                sample_embeddings=sample_embeddings,
                comparison_embeddings={
                    model_key: self._build_reference_embedding(model_embeddings)
                    for model_key, model_embeddings in comparison_sample_embeddings.items()
                },
                comparison_sample_embeddings=comparison_sample_embeddings,
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
            model_provenance=self._collect_provenance(),
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
        speaker = self._ensure_comparison_embeddings(speaker)

        total_t0 = perf_counter()
        payload, audio_timings = self.audio.decode_wav_with_timings(audio_bytes)
        trimmed, vad_ms = self.audio.trim_to_voice(payload)
        audio_timings.vad_ms = vad_ms

        t0 = perf_counter()
        query_embedding = self.encoder.embed(trimmed.waveform)
        embed_ms = (perf_counter() - t0) * 1000.0

        t0 = perf_counter()
        deepfake_score = self.detector.detect(trimmed.waveform)
        detect_ms = (perf_counter() - t0) * 1000.0

        sample_similarities = [
            _clamp_unit(self.encoder.cosine_similarity(sample_embedding, query_embedding))
            for sample_embedding in speaker.sample_embeddings
        ]
        centroid_similarity = _clamp_unit(
            self.encoder.cosine_similarity(speaker.embedding, query_embedding)
        )
        similarity_score = _clamp_unit(
            self._aggregate_similarity(sample_similarities, centroid_similarity)
        )
        speaker_model_scores = self._build_speaker_model_scores(
            speaker=speaker,
            query_waveform=trimmed.waveform,
            primary_sample_similarities=sample_similarities,
            primary_centroid_similarity=centroid_similarity,
            primary_similarity_score=similarity_score,
        )
        speaker_fusion = self._build_speaker_fusion(speaker_model_scores)
        similarity_score = speaker_fusion.combined_similarity_score
        deepfake_score = _clamp_unit(deepfake_score)

        decision, reason, message = self._decide(speaker_fusion, deepfake_score)
        analysis_details = self.acoustic_probe.score(trimmed.waveform, sample_rate=trimmed.sample_rate)

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
                "speaker_model_scores": [score.model_dump() for score in speaker_model_scores],
                "speaker_fusion": speaker_fusion.model_dump(),
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
            speaker_model_scores=speaker_model_scores,
            speaker_fusion=speaker_fusion,
            analysis_details=analysis_details,
            model_provenance=self._collect_provenance(),
            query_embeddings=self._query_embeddings(trimmed.waveform, primary=query_embedding),
            created_at=created_at,
        )

    def identify(self, audio_bytes: bytes, top_n: int = 3) -> IdentificationResponse:
        speakers = self.store.list_users()
        if not speakers:
            raise RuntimeError("No users enrolled. Enrol at least one profile first.")

        payload, _ = self.audio.decode_wav_with_timings(audio_bytes)
        trimmed, _ = self.audio.trim_to_voice(payload)
        query_embedding = self.encoder.embed(trimmed.waveform)
        deepfake_score = _clamp_unit(self.detector.detect(trimmed.waveform))
        analysis_details = self.acoustic_probe.score(trimmed.waveform, sample_rate=trimmed.sample_rate)
        speakers = [self._ensure_comparison_embeddings(speaker) for speaker in speakers]

        scored: list[tuple[IdentificationMatch, SpeakerFusionDecision]] = []
        primary_scored: list[IdentificationMatch] = []
        for speaker in speakers:
            sample_sims = [
                _clamp_unit(self.encoder.cosine_similarity(s, query_embedding))
                for s in speaker.sample_embeddings
            ]
            centroid_sim = _clamp_unit(
                self.encoder.cosine_similarity(speaker.embedding, query_embedding)
            )
            similarity = _clamp_unit(self._aggregate_similarity(sample_sims, centroid_sim))
            primary_match = IdentificationMatch(
                user_id=speaker.user_id,
                similarity_score=similarity,
                centroid_similarity=centroid_sim,
                sample_count=speaker.sample_count,
                enrolled_at=speaker.enrolled_at,
            )
            primary_scored.append(primary_match)
            speaker_model_scores = self._build_speaker_model_scores(
                speaker=speaker,
                query_waveform=trimmed.waveform,
                primary_sample_similarities=sample_sims,
                primary_centroid_similarity=centroid_sim,
                primary_similarity_score=similarity,
            )
            fusion = self._build_speaker_fusion(speaker_model_scores)
            scored.append(
                (
                    IdentificationMatch(
                        user_id=speaker.user_id,
                        similarity_score=fusion.combined_similarity_score,
                        centroid_similarity=centroid_sim,
                        sample_count=speaker.sample_count,
                        enrolled_at=speaker.enrolled_at,
                    ),
                    fusion,
                )
            )

        scored.sort(
            key=lambda item: (
                item[1].matched_models,
                item[1].combined_similarity_score,
                item[0].centroid_similarity,
            ),
            reverse=True,
        )
        top_scored = scored[: max(1, top_n)]
        top = [match for match, _ in top_scored]
        primary_scored.sort(key=lambda match: match.similarity_score, reverse=True)
        speaker_model_matches = self._build_identification_model_matches(
            speakers=speakers,
            query_waveform=trimmed.waveform,
            primary_matches=primary_scored[: max(1, top_n)],
            top_n=max(1, top_n),
        )
        top_fusion = top_scored[0][1] if top_scored else None
        would_accept = (
            bool(top_fusion and top_fusion.combined_match)
            and deepfake_score >= self.deepfake_threshold
        )
        return IdentificationResponse(
            matches=top,
            speaker_model_matches=speaker_model_matches,
            speaker_fusion=top_fusion,
            deepfake_score=deepfake_score,
            analysis_details=analysis_details,
            would_accept_top1=would_accept,
            similarity_threshold=self.similarity_threshold,
            deepfake_threshold=self.deepfake_threshold,
            n_enrolled_total=len(speakers),
            model_provenance=self._collect_provenance(),
            query_embeddings=self._query_embeddings(trimmed.waveform, primary=query_embedding),
        )

    def get_result(self, user_id: str, result_id: str) -> VerificationResponse | None:
        record = self.store.get_result(result_id)
        if record is None or record.user_id != user_id:
            return None
        return self._record_to_response(record)

    def list_results(self) -> list[VerificationResponse]:
        return [self._record_to_response(record) for record in self.store.list_results()]

    def _decide(self, speaker_fusion: SpeakerFusionDecision, deepfake_score: float) -> tuple[str, DecisionReason, str]:
        if deepfake_score < self.deepfake_threshold:
            return "DEEPFAKE", "synthetic", _SYNTHETIC_MESSAGE
        if speaker_fusion.combined_match:
            return "ACCEPT", "accepted", _ACCEPT_MESSAGE
        return "REJECT", "mismatch", _MISMATCH_MESSAGE

    def _record_to_response(self, record: VerificationRecord) -> VerificationResponse:
        meta = record.metadata or {}
        analysis_dict = meta.get("analysis_details")
        analysis_details = AnalysisDetails.model_validate(analysis_dict) if analysis_dict else None
        stage_dict = meta.get("stage_breakdown") or {}
        stage_breakdown = StageBreakdown.model_validate(stage_dict)
        speaker_model_scores = [
            SpeakerModelScore.model_validate(item)
            for item in meta.get("speaker_model_scores", [])
        ]
        speaker_fusion_dict = meta.get("speaker_fusion")
        speaker_fusion = (
            SpeakerFusionDecision.model_validate(speaker_fusion_dict)
            if speaker_fusion_dict
            else None
        )
        reason = meta.get("decision_reason") or self._reason_from_decision(record.decision)
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
            speaker_model_scores=speaker_model_scores,
            speaker_fusion=speaker_fusion,
            analysis_details=analysis_details,
            model_provenance=self._collect_provenance(),
            created_at=record.created_at,
        )

    @staticmethod
    def _reason_from_decision(decision: str) -> DecisionReason:
        if decision == "ACCEPT":
            return "accepted"
        if decision == "DEEPFAKE":
            return "synthetic"
        return "mismatch"

    def _build_comparison_sample_embeddings(self, waveform: list[float]) -> dict[str, list[float]]:
        return {
            model_key: encoder.embed(waveform)
            for model_key, encoder in self.comparison_encoders.items()
        }

    def _query_embeddings(self, waveform: list[float], primary: list[float] | None = None) -> dict[str, list[float]]:
        """Raw query embedding per active speaker model, for projecting the
        queried voice into the embedding space client-side."""
        out: dict[str, list[float]] = {
            "redimnet_b5": primary if primary is not None else self.encoder.embed(waveform)
        }
        for model_key, encoder in self.comparison_encoders.items():
            out[model_key] = encoder.embed(waveform)
        return out

    def _build_speaker_model_scores(
        self,
        speaker: SpeakerRecord,
        query_waveform: list[float],
        primary_sample_similarities: list[float],
        primary_centroid_similarity: float,
        primary_similarity_score: float,
    ) -> list[SpeakerModelScore]:
        scores = [
            SpeakerModelScore(
                model_key="redimnet_b5",
                similarity_score=primary_similarity_score,
                centroid_similarity=primary_centroid_similarity,
                sample_similarities=primary_sample_similarities,
                threshold=self._threshold_for_model("redimnet_b5"),
                passed_threshold=primary_similarity_score >= self._threshold_for_model("redimnet_b5"),
                drives_decision=True,
            )
        ]
        for model_key, encoder in self.comparison_encoders.items():
            query_embedding = encoder.embed(query_waveform)
            sample_embeddings = speaker.comparison_sample_embeddings.get(model_key, [])
            centroid_embedding = speaker.comparison_embeddings.get(model_key, [])
            sample_similarities = [
                _clamp_unit(encoder.cosine_similarity(sample_embedding, query_embedding))
                for sample_embedding in sample_embeddings
            ]
            centroid_similarity = 0.0
            if centroid_embedding:
                centroid_similarity = _clamp_unit(
                    encoder.cosine_similarity(centroid_embedding, query_embedding)
                )
            similarity_score = _clamp_unit(self._aggregate_similarity(sample_similarities, centroid_similarity))
            scores.append(
                SpeakerModelScore(
                    model_key=model_key,
                    similarity_score=similarity_score,
                    centroid_similarity=centroid_similarity,
                    sample_similarities=sample_similarities,
                    threshold=self._threshold_for_model(model_key),
                    passed_threshold=similarity_score >= self._threshold_for_model(model_key),
                    drives_decision=True,
                )
            )
        return scores

    def _build_speaker_fusion(self, scores: list[SpeakerModelScore]) -> SpeakerFusionDecision:
        total_models = len(scores)
        majority_required = (total_models // 2) + 1 if total_models else 0
        decisive_model_keys = [score.model_key for score in scores if score.passed_threshold]
        matched_models = len(decisive_model_keys)
        combined_similarity_score = _clamp_unit(
            fmean(score.similarity_score for score in scores) if scores else 0.0
        )
        return SpeakerFusionDecision(
            strategy="majority_vote",
            combined_match=matched_models >= majority_required,
            combined_similarity_score=combined_similarity_score,
            matched_models=matched_models,
            total_models=total_models,
            majority_required=majority_required,
            decisive_model_keys=decisive_model_keys,
        )

    def _threshold_for_model(self, model_key: str) -> float:
        return _clamp_unit(self.model_similarity_thresholds.get(model_key, self.similarity_threshold))

    def _ensure_comparison_embeddings(self, speaker: SpeakerRecord) -> SpeakerRecord:
        if not self.comparison_encoders:
            return speaker
        needs_backfill = any(
            len(speaker.comparison_sample_embeddings.get(model_key, [])) < speaker.sample_count
            for model_key in self.comparison_encoders
        )
        if not needs_backfill:
            return speaker

        references = sorted(self.store.list_reference_samples(speaker.user_id), key=lambda sample: sample.created_at)
        if not references:
            return speaker

        comparison_sample_embeddings = {
            model_key: list(model_embeddings)
            for model_key, model_embeddings in speaker.comparison_sample_embeddings.items()
        }
        for model_key, encoder in self.comparison_encoders.items():
            if len(comparison_sample_embeddings.get(model_key, [])) >= speaker.sample_count:
                continue
            model_embeddings: list[list[float]] = []
            for reference in references:
                audio_bytes = self._read_reference_sample_bytes(reference)
                if not audio_bytes:
                    continue
                payload = self.audio.decode_wav(audio_bytes)
                trimmed, _ = self.audio.trim_to_voice(payload)
                model_embeddings.append(encoder.embed(trimmed.waveform))
            if model_embeddings:
                comparison_sample_embeddings[model_key] = model_embeddings

        comparison_embeddings = {
            model_key: self._build_reference_embedding(model_embeddings)
            for model_key, model_embeddings in comparison_sample_embeddings.items()
            if model_embeddings
        }
        hydrated = SpeakerRecord(
            user_id=speaker.user_id,
            embedding=speaker.embedding,
            sample_embeddings=speaker.sample_embeddings,
            comparison_embeddings=comparison_embeddings,
            comparison_sample_embeddings=comparison_sample_embeddings,
            enrolled_at=speaker.enrolled_at,
            sample_count=speaker.sample_count,
        )
        self.store.put_speaker(hydrated)
        return hydrated

    def _build_identification_model_matches(
        self,
        speakers: list[SpeakerRecord],
        query_waveform: list[float],
        primary_matches: list[IdentificationMatch],
        top_n: int,
    ) -> list[SpeakerModelMatches]:
        grouped = [
            SpeakerModelMatches(
                model_key="redimnet_b5",
                matches=primary_matches,
                drives_decision=True,
            )
        ]
        for model_key, encoder in self.comparison_encoders.items():
            query_embedding = encoder.embed(query_waveform)
            matches: list[IdentificationMatch] = []
            for speaker in speakers:
                sample_embeddings = speaker.comparison_sample_embeddings.get(model_key, [])
                centroid_embedding = speaker.comparison_embeddings.get(model_key, [])
                sample_sims = [
                    _clamp_unit(encoder.cosine_similarity(sample_embedding, query_embedding))
                    for sample_embedding in sample_embeddings
                ]
                centroid_sim = 0.0
                if centroid_embedding:
                    centroid_sim = _clamp_unit(encoder.cosine_similarity(centroid_embedding, query_embedding))
                similarity = _clamp_unit(self._aggregate_similarity(sample_sims, centroid_sim))
                matches.append(
                    IdentificationMatch(
                        user_id=speaker.user_id,
                        similarity_score=similarity,
                        centroid_similarity=centroid_sim,
                        sample_count=speaker.sample_count,
                        enrolled_at=speaker.enrolled_at,
                    )
                )
            matches.sort(key=lambda match: match.similarity_score, reverse=True)
            grouped.append(
                SpeakerModelMatches(
                    model_key=model_key,
                    matches=matches[:top_n],
                    drives_decision=True,
                )
            )
        return grouped

    def _encoder_for_model(self, model_key: SpeakerModelKey) -> SpeakerEncoder:
        if model_key == "redimnet_b5":
            return self.encoder
        encoder = self.comparison_encoders.get(model_key)
        if encoder is None:
            raise ValueError(f"Speaker model '{model_key}' is not available")
        return encoder

    def _embeddings_for_model(
        self,
        speaker: SpeakerRecord,
        model_key: SpeakerModelKey,
    ) -> tuple[list[float], list[list[float]]]:
        if model_key == "redimnet_b5":
            return speaker.embedding, speaker.sample_embeddings
        centroid = speaker.comparison_embeddings.get(model_key, [])
        samples = speaker.comparison_sample_embeddings.get(model_key, [])
        if not centroid and not samples:
            raise ValueError(f"Speaker model '{model_key}' has no stored embeddings")
        return centroid, samples

    @staticmethod
    def _read_reference_sample_bytes(reference_sample) -> bytes | None:
        audio_bytes = getattr(reference_sample, "audio_bytes", None)
        if audio_bytes:
            return audio_bytes
        path = Path(reference_sample.file_path)
        if path.exists():
            return path.read_bytes()
        return None

    @staticmethod
    def _format_session_id(seq: int, created_at: datetime) -> str:
        return f"VRF-{created_at.year:04d}{created_at.month:02d}{created_at.day:02d}-{seq:05d}"

    @staticmethod
    def _legacy_session_id(result_id: str, created_at: datetime) -> str:
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
