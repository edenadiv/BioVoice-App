"""F6 — admin surface (operator-only).

All routes mounted under `/admin/*` are gated by the
`require_admin_key` dependency: the caller must present
`X-Admin-API-Key` matching the `BIOVOICE_ADMIN_API_KEY` env var. When
the env var is unset (default) every admin route returns 503 — the
surface is explicitly opt-in.

Operations exposed:

  - DELETE /admin/users/{user_id}      F6.1 — soft-delete a profile.
  - GET    /admin/audit                F6.2 — paginated audit feed.
  - GET    /admin/settings/thresholds  F6.3 — current threshold values.
  - PUT    /admin/settings/thresholds  F6.3 — update thresholds.

Every mutating call writes an audit_log row.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.api.dependencies import (
    get_audit_service,
    get_container,
    get_verification_service,
    require_admin_key,
)
from app.services.audit import AuditService
from app.services.verification import VerificationService


admin_router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin_key)])


# -----------------------------------------------------------------------------
# Profile management (F6.1)
# -----------------------------------------------------------------------------


class DeletedUserResponse(BaseModel):
    user_id: str
    enrolled_at: str
    deleted_at: str
    deleted_by: str | None


@admin_router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: str,
    request: Request,
    audit: AuditService = Depends(get_audit_service),
) -> None:
    container = get_container(request)
    success = container.store.soft_delete_speaker(
        user_id, deleted_by="admin", deleted_at=datetime.now(timezone.utc)
    )
    if not success:
        raise HTTPException(status_code=404, detail=f"User '{user_id}' not found")
    audit.record(
        "user.delete",
        actor="admin",
        target=user_id,
        ip=_client_ip(request),
        metadata={"soft_delete": True},
    )


@admin_router.get("/users/deleted", response_model=list[DeletedUserResponse])
def list_deleted_users(request: Request) -> list[DeletedUserResponse]:
    container = get_container(request)
    return [DeletedUserResponse(**row) for row in container.store.list_deleted_users()]


# -----------------------------------------------------------------------------
# Audit log (F6.2)
# -----------------------------------------------------------------------------


class AuditEventResponse(BaseModel):
    event_id: int
    occurred_at: str
    actor: str | None
    ip: str | None
    action: str
    target: str | None
    metadata: dict | None


@admin_router.get("/audit", response_model=list[AuditEventResponse])
def list_audit_events(
    since: str | None = None,
    limit: int = 200,
    audit: AuditService = Depends(get_audit_service),
) -> list[AuditEventResponse]:
    """`since` is an ISO-8601 timestamp (UTC). Omit it to fetch the most
    recent `limit` events across all time."""
    parsed_since: datetime | None = None
    if since is not None:
        try:
            parsed_since = datetime.fromisoformat(since)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid since timestamp: {exc}") from exc
    events = audit.recent(since=parsed_since, limit=limit)
    return [AuditEventResponse(**event) for event in events]


# -----------------------------------------------------------------------------
# Threshold tuning (F6.3)
# -----------------------------------------------------------------------------


class ThresholdSettingsResponse(BaseModel):
    similarity_threshold: float = Field(ge=0.0, le=1.0)
    deepfake_threshold: float = Field(ge=0.0, le=1.0)
    voice_naturalness_threshold: float = Field(ge=0.0, le=1.0)
    spectral_consistency_threshold: float = Field(ge=0.0, le=1.0)
    temporal_patterns_threshold: float = Field(ge=0.0, le=1.0)
    artifact_detection_threshold: float = Field(ge=0.0, le=1.0)


class ThresholdUpdate(BaseModel):
    similarity_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    deepfake_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    voice_naturalness_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    spectral_consistency_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    temporal_patterns_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    artifact_detection_threshold: float | None = Field(default=None, ge=0.0, le=1.0)


@admin_router.get("/settings/thresholds", response_model=ThresholdSettingsResponse)
def get_thresholds(request: Request) -> ThresholdSettingsResponse:
    container = get_container(request)
    s = container.settings
    return ThresholdSettingsResponse(
        similarity_threshold=s.similarity_threshold,
        deepfake_threshold=s.deepfake_threshold,
        voice_naturalness_threshold=s.voice_naturalness_threshold,
        spectral_consistency_threshold=s.spectral_consistency_threshold,
        temporal_patterns_threshold=s.temporal_patterns_threshold,
        artifact_detection_threshold=s.artifact_detection_threshold,
    )


@admin_router.put("/settings/thresholds", response_model=ThresholdSettingsResponse)
def update_thresholds(
    request: Request,
    payload: ThresholdUpdate = Body(...),
    audit: AuditService = Depends(get_audit_service),
    service: VerificationService = Depends(get_verification_service),
) -> ThresholdSettingsResponse:
    container = get_container(request)
    s = container.settings
    diff: dict[str, tuple[float, float]] = {}
    for field, value in payload.model_dump(exclude_none=True).items():
        old = getattr(s, field)
        if old != value:
            setattr(s, field, value)
            diff[field] = (old, value)
    # The two thresholds the verification path actually uses live on
    # VerificationService too; mirror them so the running service picks up
    # the change without a restart.
    if "similarity_threshold" in diff:
        service.similarity_threshold = s.similarity_threshold
    if "deepfake_threshold" in diff:
        service.deepfake_threshold = s.deepfake_threshold
    audit.record(
        "threshold.update",
        actor="admin",
        ip=_client_ip(request),
        target=",".join(diff.keys()) or "unchanged",
        metadata={k: {"old": old, "new": new} for k, (old, new) in diff.items()},
    )
    return ThresholdSettingsResponse(
        similarity_threshold=s.similarity_threshold,
        deepfake_threshold=s.deepfake_threshold,
        voice_naturalness_threshold=s.voice_naturalness_threshold,
        spectral_consistency_threshold=s.spectral_consistency_threshold,
        temporal_patterns_threshold=s.temporal_patterns_threshold,
        artifact_detection_threshold=s.artifact_detection_threshold,
    )


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").strip()
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"
