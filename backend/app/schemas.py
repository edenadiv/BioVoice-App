"""Pydantic response models for the API."""

from datetime import datetime

from pydantic import BaseModel, Field


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


class VerificationResponse(BaseModel):
    result_id: str
    user_id: str
    decision: str
    similarity_score: float = Field(ge=0.0, le=1.0)
    deepfake_score: float = Field(ge=0.0, le=1.0)
    centroid_similarity: float = Field(ge=0.0, le=1.0, default=0.0)
    sample_similarities: list[float] = Field(default_factory=list)
    message: str
    created_at: datetime


class SessionResponse(BaseModel):
    session_token: str
    user_id: str
    created_at: datetime


class AuthSessionResponse(BaseModel):
    session: SessionResponse
    verification: VerificationResponse
