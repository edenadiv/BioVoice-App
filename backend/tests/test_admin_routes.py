"""F6 — admin surface tests.

Covers:
  - X-Admin-API-Key gating: 503 when env var unset, 401 when wrong, 204
    on success.
  - DELETE /admin/users/{id} removes the speaker, lists in deleted_users,
    writes a 'user.delete' audit event.
  - GET /admin/audit returns the appended events; `since` filter works.
  - PUT /admin/settings/thresholds mutates Settings + VerificationService
    and writes a 'threshold.update' audit row.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import admin_routes, dependencies, routes
from app.api.admin_routes import admin_router
from app.core.config import Settings
from app.services.audit import AuditService
from app.services.auth import AuthService
from app.services.verification import VerificationService
from app.storage.memory_store import MemoryStore

from .conftest import HashEncoder, SAMPLE_RATE, StubDetector, make_wav


@dataclass
class _Container:
    settings: Settings
    store: MemoryStore
    audit_service: AuditService
    verification_service: VerificationService
    auth_service: AuthService


def _build_app(*, admin_key: str | None = "secret-test-key") -> tuple[TestClient, _Container]:
    settings = Settings()
    settings.admin_api_key = admin_key
    store = MemoryStore()
    detector = StubDetector(score=0.9)
    encoder = HashEncoder()
    verification = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=encoder,
        sample_rate=SAMPLE_RATE,
        similarity_threshold=settings.similarity_threshold,
        deepfake_threshold=settings.deepfake_threshold,
        min_enrollment_samples=3,
    )
    audit = AuditService(store=store)
    auth = AuthService(
        store=store, verification_service=verification, idle_seconds=600, audit_service=audit
    )
    container = _Container(
        settings=settings,
        store=store,
        audit_service=audit,
        verification_service=verification,
        auth_service=auth,
    )

    app = FastAPI()
    app.state.container = container  # the require_admin_key dep reads from here
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_audit_service] = lambda: audit
    app.dependency_overrides[dependencies.get_auth_service] = lambda: auth
    app.include_router(admin_router)
    app.include_router(routes.router)
    return TestClient(app, base_url="https://testserver"), container


def _enrol(verification: VerificationService, user_id: str = "alice") -> None:
    wav = make_wav(2.0)
    for _ in range(3):
        verification.enroll(user_id=user_id, audio_bytes=wav, filename="enrol.wav")


# -----------------------------------------------------------------------------
# Auth gating
# -----------------------------------------------------------------------------


def test_admin_routes_disabled_without_env_key():
    client, _ = _build_app(admin_key=None)
    resp = client.get("/admin/audit")
    assert resp.status_code == 503
    assert "BIOVOICE_ADMIN_API_KEY" in resp.json()["detail"]


def test_admin_routes_reject_missing_header():
    client, _ = _build_app()
    resp = client.get("/admin/audit")
    assert resp.status_code == 401


def test_admin_routes_reject_wrong_header():
    client, _ = _build_app()
    resp = client.get("/admin/audit", headers={"X-Admin-API-Key": "WRONG"})
    assert resp.status_code == 401


# -----------------------------------------------------------------------------
# Delete flow (F6.1)
# -----------------------------------------------------------------------------


def test_delete_user_removes_speaker_and_writes_audit():
    client, container = _build_app()
    _enrol(container.verification_service, user_id="bob")
    assert container.store.get_speaker("bob") is not None

    resp = client.delete(
        "/admin/users/bob", headers={"X-Admin-API-Key": "secret-test-key"}
    )
    assert resp.status_code == 204
    assert container.store.get_speaker("bob") is None

    deleted = container.store.list_deleted_users()
    assert len(deleted) == 1
    assert deleted[0]["user_id"] == "bob"

    events = container.store.list_audit_events()
    delete_events = [e for e in events if e["action"] == "user.delete"]
    assert len(delete_events) == 1
    assert delete_events[0]["target"] == "bob"


def test_delete_unknown_user_returns_404():
    client, _ = _build_app()
    resp = client.delete(
        "/admin/users/never-enrolled", headers={"X-Admin-API-Key": "secret-test-key"}
    )
    assert resp.status_code == 404


# -----------------------------------------------------------------------------
# Audit feed (F6.2)
# -----------------------------------------------------------------------------


def test_audit_feed_returns_recent_events():
    client, container = _build_app()
    _enrol(container.verification_service)
    container.audit_service.record("test.event", actor="admin", target="x")

    resp = client.get("/admin/audit", headers={"X-Admin-API-Key": "secret-test-key"})
    assert resp.status_code == 200
    body = resp.json()
    assert any(e["action"] == "test.event" for e in body)


def test_audit_feed_since_filter():
    client, container = _build_app()
    container.audit_service.record("old.event")
    # Cutoff in the future — nothing should match.
    resp = client.get(
        "/admin/audit",
        params={"since": "2099-01-01T00:00:00+00:00"},
        headers={"X-Admin-API-Key": "secret-test-key"},
    )
    assert resp.status_code == 200
    assert resp.json() == []


def test_audit_feed_invalid_since_returns_400():
    client, _ = _build_app()
    resp = client.get(
        "/admin/audit",
        params={"since": "not-a-date"},
        headers={"X-Admin-API-Key": "secret-test-key"},
    )
    assert resp.status_code == 400


# -----------------------------------------------------------------------------
# Login / logout audit integration
# -----------------------------------------------------------------------------


def test_login_writes_audit_event():
    client, container = _build_app()
    _enrol(container.verification_service, user_id="charlie")
    wav = make_wav(2.0)
    resp = client.post(
        "/auth/login",
        data={"user_id": "charlie"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 200, resp.text

    events = container.store.list_audit_events()
    actions = {e["action"] for e in events}
    assert "login.success" in actions


# -----------------------------------------------------------------------------
# Threshold tuning (F6.3)
# -----------------------------------------------------------------------------


def test_get_thresholds_returns_current_settings():
    client, container = _build_app()
    resp = client.get(
        "/admin/settings/thresholds", headers={"X-Admin-API-Key": "secret-test-key"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["similarity_threshold"] == container.settings.similarity_threshold


def test_put_thresholds_mutates_settings_and_writes_audit():
    client, container = _build_app()
    resp = client.put(
        "/admin/settings/thresholds",
        json={"similarity_threshold": 0.82},
        headers={"X-Admin-API-Key": "secret-test-key"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["similarity_threshold"] == 0.82
    assert container.settings.similarity_threshold == 0.82
    # The mirror onto the live VerificationService picks up the change.
    assert container.verification_service.similarity_threshold == 0.82
    # Audit event recorded with the diff in metadata.
    events = container.store.list_audit_events()
    threshold_events = [e for e in events if e["action"] == "threshold.update"]
    assert len(threshold_events) == 1
    diff = threshold_events[0]["metadata"]
    assert "similarity_threshold" in diff


def test_put_thresholds_rejects_out_of_range():
    client, _ = _build_app()
    resp = client.put(
        "/admin/settings/thresholds",
        json={"similarity_threshold": 1.5},
        headers={"X-Admin-API-Key": "secret-test-key"},
    )
    assert resp.status_code == 422  # FastAPI validation
