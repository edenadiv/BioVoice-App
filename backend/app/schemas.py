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


class SampleQuality(BaseModel):
    """F3.3 — per-sample audio quality summary surfaced on
    EnrollmentResponse so operators can show a quality score on the kiosk
    sample dots and explain rejected samples without digging through logs.
    """

    score: float = Field(ge=0.0, le=100.0)
    snr_db: float
    clipping_pct: float = Field(ge=0.0, le=100.0)
    speech_ratio: float = Field(ge=0.0, le=1.0)
    acceptable: bool


class EnrollmentResponse(BaseModel):
    user_id: str
    status: str
    message: str
    enrolled_at: datetime
    quality: SampleQuality | None = None


class StageBreakdown(BaseModel):
    """Per-stage timings for the verification pipeline.

    Per Plan §4 architectural decision 5: timings reflect what the server actually
    measures. mel_ms is rolled into embed_ms because ReDimNet handles mel-spec
    extraction internally and we don't separate it.

    F3.2 added `vad_ms` for the Voice Activity Detection trim that runs
    between normalize and embed.
    """

    load_ms: float = 0.0
    resample_ms: float = 0.0
    normalize_ms: float = 0.0
    vad_ms: float = 0.0
    embed_ms: float = 0.0
    detect_ms: float = 0.0
    total_ms: float = 0.0


class AnalysisDetails(BaseModel):
    """Sub-scores rendered on the Deepfake Result screen (Fig. 17).

    F4 — produced by `AcousticProbe.score()` in
    `app/services/sub_classifier.py`. In heuristic mode (default) each
    axis is a direct function of interpretable acoustic features (HNR,
    voiced ratio, spectral flatness, F0 variance) — see
    `docs/paper/sub_classifier.md` §3. In trained-head mode (when
    `aasist_heads.pt` is present) four 75→64→1 MLPs score each axis
    from the AcousticFeatures vector.
    """

    voice_naturalness: float = Field(ge=0.0, le=1.0)
    spectral_consistency: float = Field(ge=0.0, le=1.0)
    temporal_patterns: float = Field(ge=0.0, le=1.0)
    artifact_detection: float = Field(ge=0.0, le=1.0)


SpoofDecision = Literal["FAKE", "GENUINE"]


class SpoofTestResponse(BaseModel):
    """G14 — payload for `POST /me/spoof/test`. The DeepfakeLab UI uses
    this to score an arbitrary uploaded WAV (typically the just-generated
    XTTS clone) against AASIST + the F4 sub-classifier. Mirrors the
    contract the frontend `lib/api.ts:spoofTest()` expects."""

    deepfake_score: float = Field(ge=0.0, le=1.0)
    decision: SpoofDecision
    analysis_details: AnalysisDetails


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


class AvailabilityResponse(BaseModel):
    available: bool
