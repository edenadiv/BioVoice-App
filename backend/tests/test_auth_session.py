"""F2.1 — session expiry + refresh tests.

Covers:
  - Idle window: expired session raises PermissionError on `get_session`
  - Roll-forward: every successful `get_session` bumps `expires_at`
  - `refresh_session` rotates the token and extends the deadline
  - Expired token cannot refresh
  - Logout invalidates the token
  - End-to-end via FastAPI TestClient: 401 mapping for both expired and
    refreshed paths.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.services.auth import AuthService
from app.services.verification import VerificationService

from .conftest import HashEncoder, StubDetector, make_wav, SAMPLE_RATE
from app.storage.memory_store import MemoryStore


def _service(idle_seconds: int = 30) -> tuple[AuthService, VerificationService, MemoryStore, StubDetector]:
    """Auth service backed by an in-memory store + stub detector + hash
    encoder. `idle_seconds` defaults to 30 to keep tests deterministic."""
    store = MemoryStore()
    detector = StubDetector(score=0.9)
    encoder = HashEncoder()
    verification = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=encoder,
        sample_rate=SAMPLE_RATE,
        similarity_threshold=0.75,
        deepfake_threshold=0.5,
        min_enrollment_samples=3,
    )
    return (
        AuthService(store=store, verification_service=verification, idle_seconds=idle_seconds),
        verification,
        store,
        detector,
    )


def _enrol_and_login(auth: AuthService, verification: VerificationService) -> str:
    """Enrol `alice` (3 samples) and log in. Returns the session token."""
    wav = make_wav(2.0)
    for _ in range(3):
        verification.enroll(user_id="alice", audio_bytes=wav, filename="enrol.wav")
    response = auth.login(user_id="alice", audio_bytes=wav, filename="login.wav")
    return response.session.session_token


# -----------------------------------------------------------------------------
# Login + initial expiry
# -----------------------------------------------------------------------------


def test_login_sets_expires_at_within_idle_window():
    auth, verification, _, _ = _service(idle_seconds=1800)
    token = _enrol_and_login(auth, verification)
    session = auth.get_session(token)

    delta = session.expires_at - session.created_at
    # Allow a tiny clock-bump from the get_session refresh.
    assert timedelta(seconds=1799) < delta <= timedelta(seconds=1810)


def test_get_session_unknown_token_raises():
    auth, _, _, _ = _service()
    with pytest.raises(PermissionError, match="Session not found"):
        auth.get_session("totally-fake-token")


# -----------------------------------------------------------------------------
# Idle expiry
# -----------------------------------------------------------------------------


def test_expired_session_raises_session_expired():
    auth, verification, store, _ = _service(idle_seconds=1)
    token = _enrol_and_login(auth, verification)

    # Manually fast-forward the stored deadline to the past.
    record = store.get_session(token)
    assert record is not None
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=10)
    store.put_session(record)

    with pytest.raises(PermissionError, match="Session expired"):
        auth.get_session(token)


def test_expired_session_is_deleted_on_access():
    auth, verification, store, _ = _service(idle_seconds=1)
    token = _enrol_and_login(auth, verification)
    record = store.get_session(token)
    assert record is not None
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=10)
    store.put_session(record)

    with pytest.raises(PermissionError):
        auth.get_session(token)
    # Cleanup happened — the token is now unknown.
    assert store.get_session(token) is None


# -----------------------------------------------------------------------------
# Roll-forward on successful get_session
# -----------------------------------------------------------------------------


def test_get_session_bumps_expires_at():
    auth, verification, store, _ = _service(idle_seconds=600)
    token = _enrol_and_login(auth, verification)
    record_before = store.get_session(token)
    assert record_before is not None
    # Snapshot scalars (MemoryStore returns the same dataclass reference, so
    # mutations on the live record would leak into our before-image).
    initial_expiry = record_before.expires_at
    initial_last_seen = record_before.last_seen_at

    # Advance wall-clock by 30 s; access should roll the deadline forward.
    later = datetime.now(timezone.utc) + timedelta(seconds=30)
    with patch("app.services.auth.datetime") as dt_mock:
        dt_mock.now.return_value = later
        auth.get_session(token)

    record_after = store.get_session(token)
    assert record_after is not None
    assert record_after.expires_at > initial_expiry
    assert record_after.last_seen_at > initial_last_seen


# -----------------------------------------------------------------------------
# refresh_session — rotate token + extend deadline
# -----------------------------------------------------------------------------


def test_refresh_rotates_token_and_extends_deadline():
    auth, verification, store, _ = _service(idle_seconds=300)
    old_token = _enrol_and_login(auth, verification)
    old_record = store.get_session(old_token)
    assert old_record is not None
    old_expiry = old_record.expires_at

    later = datetime.now(timezone.utc) + timedelta(seconds=60)
    with patch("app.services.auth.datetime") as dt_mock:
        dt_mock.now.return_value = later
        new = auth.refresh_session(old_token)

    # The token is new.
    assert new.session_token != old_token
    # Old token no longer resolves.
    assert store.get_session(old_token) is None
    # New deadline is past the old one.
    assert new.expires_at > old_expiry
    # Created-at is preserved across rotation (history of session start).
    assert new.created_at == old_record.created_at


def test_refresh_with_unknown_token_raises():
    auth, _, _, _ = _service()
    with pytest.raises(PermissionError, match="Session not found"):
        auth.refresh_session("never-issued")


def test_refresh_outside_idle_window_raises():
    auth, verification, store, _ = _service(idle_seconds=10)
    token = _enrol_and_login(auth, verification)
    record = store.get_session(token)
    assert record is not None
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    store.put_session(record)

    with pytest.raises(PermissionError, match="Session expired"):
        auth.refresh_session(token)


# -----------------------------------------------------------------------------
# Logout
# -----------------------------------------------------------------------------


def test_logout_invalidates_token():
    auth, verification, store, _ = _service()
    token = _enrol_and_login(auth, verification)
    auth.logout(token)
    assert store.get_session(token) is None
    with pytest.raises(PermissionError):
        auth.get_session(token)


# -----------------------------------------------------------------------------
# End-to-end via FastAPI TestClient
# -----------------------------------------------------------------------------


def test_e2e_refresh_returns_new_token_and_401_after_expiry():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import dependencies, routes

    auth, verification, store, _ = _service(idle_seconds=600)

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_auth_service] = lambda: auth
    app.include_router(routes.router)
    client = TestClient(app)

    token = _enrol_and_login(auth, verification)

    # /auth/refresh with a valid token → 200 + new token
    resp = client.post("/auth/refresh", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200, resp.text
    new_token = resp.json()["session_token"]
    assert new_token != token

    # Old token now 401
    resp = client.get("/auth/session", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401

    # New token still works
    resp = client.get("/auth/session", headers={"Authorization": f"Bearer {new_token}"})
    assert resp.status_code == 200
    assert resp.json()["session_token"] == new_token


def test_e2e_expired_session_returns_401():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import dependencies, routes

    auth, verification, store, _ = _service(idle_seconds=10)

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_auth_service] = lambda: auth
    app.include_router(routes.router)
    client = TestClient(app)

    token = _enrol_and_login(auth, verification)
    record = store.get_session(token)
    assert record is not None
    record.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
    store.put_session(record)

    resp = client.get("/auth/session", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 401
    assert "expired" in resp.json()["detail"].lower()
