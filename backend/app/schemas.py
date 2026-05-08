"""Pydantic response models for the API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


DecisionReason = Literal["accepted", "mismatch", "synthetic", "not_enrolled"]


class HealthResponse(BaseModel):
    status: str


class SpeakerResponse(BaseModel):
    user_id: str
    enrolled_at: datetime
    sample_count: int


class ReferenceSampleResponse(BaseModel):
    sample_id: str
    user_id: str
    original_filename: str
    source: str
    created_at: datetime


class EnrollmentResponse(BaseModel):
    user_id: str
    status: str
    message: str
    enrolled_at: datetime


class StageBreakdown(BaseModel):
    """Per-stage timings for the verification pipeline.

    Per Plan §4 architectural decision 5: timings reflect what the server actually
    measures. mel_ms is rolled into embed_ms because ReDimNet handles mel-spec
    extraction internally and we don't separate it.
    """

    load_ms: float = 0.0
    resample_ms: float = 0.0
    normalize_ms: float = 0.0
    embed_ms: float = 0.0
    detect_ms: float = 0.0
    total_ms: float = 0.0


class AnalysisDetails(BaseModel):
    """Sub-scores rendered on the Deepfake Result screen (Fig. 17).

    Yoav owns the AASIST-anchored derivation in Y-8 (see `detector.py`). Until
    that lands, these mirror the raw deepfake score with placeholder semantics.
    """

    voice_naturalness: float = Field(ge=0.0, le=1.0)
    spectral_consistency: float = Field(ge=0.0, le=1.0)
    temporal_patterns: float = Field(ge=0.0, le=1.0)
    artifact_detection: float = Field(ge=0.0, le=1.0)


class VerificationResponse(BaseModel):
    result_id: str
    user_id: str
    decision: str
    decision_reason: DecisionReason
    similarity_score: float = Field(ge=0.0, le=1.0)
    deepfake_score: float = Field(ge=0.0, le=1.0)
    centroid_similarity: float = Field(ge=0.0, le=1.0, default=0.0)
    sample_similarities: list[float] = Field(default_factory=list)
    message: str
    session_id: str
    stage_breakdown: StageBreakdown = Field(default_factory=StageBreakdown)
    analysis_details: AnalysisDetails | None = None
    created_at: datetime


class SessionResponse(BaseModel):
    session_token: str
    user_id: str
    created_at: datetime
    expires_at: datetime  # F2.1 — surface the deadline so the client can refresh proactively


class AuthSessionResponse(BaseModel):
    session: SessionResponse
    verification: VerificationResponse


class AvailabilityResponse(BaseModel):
    available: bool
