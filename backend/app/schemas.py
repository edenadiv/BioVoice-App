"""Pydantic response models for the API."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


DecisionReason = Literal["accepted", "mismatch", "synthetic", "not_enrolled"]

EncoderProvenance = Literal["redimnet_b5", "heuristic_placeholder"]
DetectorProvenance = Literal["aasist", "heuristic"]
ProbeProvenance = Literal["heuristic", "trained_heads"]


class ModelProvenance(BaseModel):
    """Which engines produced the scores in this response. `is_degraded`
    is true iff any subsystem is in heuristic-fallback mode — the UI
    should surface a banner so the operator knows the score isn't real
    ML output."""

    encoder: EncoderProvenance
    detector: DetectorProvenance
    acoustic_probe: ProbeProvenance
    is_degraded: bool


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
    model_provenance: ModelProvenance | None = None


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
    # HF3 — surfaces audit F-3: the four sub-axes are NOT derived from
    # AASIST. They're sigmoid-squashed acoustic features (HNR / F0
    # stability / spectral flatness) by default. v1.0 ships without
    # trained probe heads → every score is `heuristic`. UI labels the
    # panel accordingly.
    mode: Literal["heuristic", "trained_heads"] = "heuristic"


SpoofDecision = Literal["FAKE", "GENUINE"]


class SpoofTestResponse(BaseModel):
    """G14 — payload for `POST /me/spoof/test`. The DeepfakeLab UI uses
    this to score an arbitrary uploaded WAV (typically the just-generated
    XTTS clone) against AASIST + the F4 sub-classifier. Mirrors the
    contract the frontend `lib/api.ts:spoofTest()` expects."""

    deepfake_score: float = Field(ge=0.0, le=1.0)
    decision: SpoofDecision
    analysis_details: AnalysisDetails
    model_provenance: ModelProvenance | None = None


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
    model_provenance: ModelProvenance | None = None
    created_at: datetime


class AvailabilityResponse(BaseModel):
    available: bool


class IdentificationMatch(BaseModel):
    """One row in the ranked top-N from POST /identify."""
    user_id: str
    similarity_score: float = Field(ge=0.0, le=1.0)
    centroid_similarity: float = Field(ge=0.0, le=1.0)
    sample_count: int = Field(ge=0)
    enrolled_at: datetime


class SpoofVoice(BaseModel):
    """One selectable voice inside a TTS engine. Surfaced by
    `GET /spoof/engines` so the DeepfakeLab UI can render a picker."""

    id: str
    label: str
    language: str | None = None


class SpoofEngineInfo(BaseModel):
    """T3 — engine descriptor returned by `GET /spoof/engines`.

    `available` reflects whether the engine's package + binaries +
    network are reachable from the running backend. Unavailable engines
    are still surfaced so the UI can grey them out."""

    id: str
    label: str
    description: str
    requires_network: bool
    available: bool
    voices: list[SpoofVoice] = Field(default_factory=list)
    default_voice: str | None = None


class SpoofEnginesResponse(BaseModel):
    """Engines + the default-pick the backend would use if the caller
    sends `engine=` empty on `POST /spoof`."""

    engines: list[SpoofEngineInfo]
    default_engine: str | None


class UserEmbedding(BaseModel):
    """V1 — one enrolled profile's stored 192-d centroid plus the
    per-sample 192-d embeddings it was averaged from. Feeds the
    operator-console EmbeddingConstellation: real ReDimNet vectors,
    PCA(3) projected client-side."""

    user_id: str
    centroid: list[float]
    samples: list[list[float]]
    sample_count: int = Field(ge=0)
    enrolled_at: datetime


class EmbedResponse(BaseModel):
    """V1 — encoder-only pass for the constellation's live point.

    No DB write, no detector call, no metrics increment. Returns the
    192-d ReDimNet vector for an arbitrary uploaded WAV, plus the
    audio QC numbers the frontend needs to decide whether to render
    the live point at full opacity."""

    embedding: list[float]
    duration_ms: float
    snr_db: float
    frame_count: int = Field(ge=0)
    model_provenance: ModelProvenance | None = None


class IdentificationResponse(BaseModel):
    """Open-set "most similar" answer. Returns the ranked top-N enrolled
    speakers given an arbitrary input WAV — no user_id required from
    the caller. Same audio pipeline as /verify minus the stored result.

    `would_accept` reflects what /verify would have decided for the
    top-1 match: similarity ≥ similarity_threshold AND deepfake_score
    ≥ deepfake_threshold."""

    matches: list[IdentificationMatch]
    deepfake_score: float = Field(ge=0.0, le=1.0)
    analysis_details: AnalysisDetails | None = None
    would_accept_top1: bool = False
    similarity_threshold: float = Field(ge=0.0, le=1.0)
    deepfake_threshold: float = Field(ge=0.0, le=1.0)
    n_enrolled_total: int = Field(ge=0)
    model_provenance: ModelProvenance | None = None
