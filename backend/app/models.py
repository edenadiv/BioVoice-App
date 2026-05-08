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
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass(slots=True)
class SpeakerRecord:
    user_id: str
    embedding: list[float]
    sample_embeddings: list[list[float]] = field(default_factory=list)
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
class SessionRecord:
    session_token: str
    user_id: str
    created_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    # F2.1 — production session expiry. `expires_at` is the absolute deadline
    # past which the session is rejected; `last_seen_at` is bumped on every
    # authenticated request so an actively-used session keeps rolling forward
    # within the idle window.
    expires_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    last_seen_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
