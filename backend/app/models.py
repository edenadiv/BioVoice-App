"""Internal data objects used by the backend."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass(slots=True)
class ReferenceSampleRecord:
    sample_id: str
    user_id: str
    file_path: str
    original_filename: str
    source: str
    audio_bytes: bytes | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass(slots=True)
class SpeakerRecord:
    user_id: str
    embedding: list[float]
    sample_embeddings: list[list[float]] = field(default_factory=list)
    comparison_embeddings: dict[str, list[float]] = field(default_factory=dict)
    comparison_sample_embeddings: dict[str, list[list[float]]] = field(default_factory=dict)
    enrolled_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    sample_count: int = 1


@dataclass(slots=True)
class VerificationRecord:
    result_id: str
    user_id: str
    decision: str
    similarity_score: float
    deepfake_score: float
    message: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    metadata: dict[str, Any] | None = None


@dataclass(slots=True)
class IdentificationRecord:
    """A persisted open-set /identify run, for the Logs tab. The full
    IdentificationResponse is stashed in `metadata` so the detail view can
    re-render it exactly; the scalar columns drive the log list summary."""

    result_id: str
    created_at: datetime
    top_user_id: str | None
    top_score: float
    deepfake_score: float
    would_accept: bool
    metadata: dict[str, Any] | None = None
