"""F2.2 — `/auth/login` rate-limit tests.

Covers:
  - 5 failures within window → 6th raises LoginRateLimited (429)
  - Lockout decay: after lockout_seconds, fresh attempt allowed
  - Successful login resets state for the (user_id, ip) pair
  - Per-(user_id, ip) isolation: locking out alice from one IP doesn't
    affect bob, and doesn't affect alice from another IP
  - End-to-end via FastAPI TestClient: 429 response carries Retry-After
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from app.services.auth import AuthService
from app.services.rate_limit import (
    LoginRateLimited,
    LoginRateLimiter,
    RateLimitConfig,
)
from app.services.verification import VerificationService

from .conftest import HashEncoder, StubDetector, make_wav, SAMPLE_RATE
from app.storage.memory_store import MemoryStore


def _make_auth(
    *,
    max_attempts: int = 5,
    window_seconds: int = 300,
    lockout_seconds: int = 900,
    idle_seconds: int = 1800,
) -> tuple[AuthService, VerificationService, MemoryStore, StubDetector, LoginRateLimiter]:
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
    limiter = LoginRateLimiter(
        store=store,
        config=RateLimitConfig(
            window_seconds=window_seconds,
            max_attempts=max_attempts,
            lockout_seconds=lockout_seconds,
        ),
    )
    auth = AuthService(
        store=store,
        verification_service=verification,
        idle_seconds=idle_seconds,
        rate_limiter=limiter,
    )
    return auth, verification, store, detector, limiter


def _enrol(verification: VerificationService, user_id: str = "alice") -> bytes:
    wav = make_wav(2.0)
    for _ in range(3):
        verification.enroll(user_id=user_id, audio_bytes=wav, filename="enrol.wav")
    return wav


# -----------------------------------------------------------------------------
# Failure counting
# -----------------------------------------------------------------------------


def test_five_failures_then_locked_out():
    auth, verification, _, detector, _ = _make_auth(max_attempts=5)
    wav = _enrol(verification)
    # Make verify fail (mismatched voice) by flipping the detector to indicate
    # synthetic — the auth flow surfaces PermissionError on non-ACCEPT decisions.
    detector.score = 0.05  # below threshold → DEEPFAKE → "Voice authentication failed"

    for i in range(5):
        with pytest.raises(PermissionError):
            auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")
    # 6th raises LoginRateLimited.
    with pytest.raises(LoginRateLimited) as excinfo:
        auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")
    assert excinfo.value.retry_after_seconds > 0
    assert excinfo.value.retry_after_seconds <= 900


def test_value_error_in_verify_also_counts_as_failure():
    """Probing for non-existent users should pay the same brute-force cost."""
    auth, _, _, _, limiter = _make_auth(max_attempts=3)
    wav = make_wav(2.0)

    # User never enrolled → ValueError from VerificationService.verify.
    for _ in range(3):
        with pytest.raises(ValueError):
            auth.login(user_id="ghost", audio_bytes=wav, ip="10.0.0.1")
    with pytest.raises(LoginRateLimited):
        auth.login(user_id="ghost", audio_bytes=wav, ip="10.0.0.1")


# -----------------------------------------------------------------------------
# Lockout decay
# -----------------------------------------------------------------------------


def test_lockout_clears_after_deadline():
    auth, verification, _, detector, _ = _make_auth(
        max_attempts=2, window_seconds=300, lockout_seconds=10
    )
    wav = _enrol(verification)
    detector.score = 0.05

    for _ in range(2):
        with pytest.raises(PermissionError):
            auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")
    with pytest.raises(LoginRateLimited):
        auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")

    # Fast-forward past the lockout deadline.
    later = datetime.now(timezone.utc) + timedelta(seconds=20)
    with patch("app.services.rate_limit.datetime") as dt_mock:
        dt_mock.now.return_value = later
        # Make verify succeed this time so we test the full success path.
        detector.score = 0.9
        response = auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")
    assert response.session.user_id == "alice"


# -----------------------------------------------------------------------------
# Reset on success
# -----------------------------------------------------------------------------


def test_successful_login_resets_failure_counter():
    auth, verification, store, detector, _ = _make_auth(max_attempts=3)
    wav = _enrol(verification)

    detector.score = 0.05
    for _ in range(2):
        with pytest.raises(PermissionError):
            auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")

    # Successful login wipes the counter.
    detector.score = 0.9
    auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")

    # 3 fresh failures should be allowed (max_attempts is 3, so the 4th locks).
    detector.score = 0.05
    for _ in range(3):
        with pytest.raises(PermissionError):
            auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")
    with pytest.raises(LoginRateLimited):
        auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")


# -----------------------------------------------------------------------------
# Per-(user_id, ip) isolation
# -----------------------------------------------------------------------------


def test_lockout_does_not_affect_other_users():
    auth, verification, _, detector, _ = _make_auth(max_attempts=2)
    wav_alice = _enrol(verification, user_id="alice")
    wav_bob = _enrol(verification, user_id="bob")
    detector.score = 0.05

    # Lock alice from 10.0.0.1
    for _ in range(2):
        with pytest.raises(PermissionError):
            auth.login(user_id="alice", audio_bytes=wav_alice, ip="10.0.0.1")
    with pytest.raises(LoginRateLimited):
        auth.login(user_id="alice", audio_bytes=wav_alice, ip="10.0.0.1")

    # Bob from the same IP can still try (and fail with mismatch, not 429).
    with pytest.raises(PermissionError):
        auth.login(user_id="bob", audio_bytes=wav_bob, ip="10.0.0.1")


def test_lockout_isolates_per_ip():
    auth, verification, _, detector, _ = _make_auth(max_attempts=2)
    wav = _enrol(verification)
    detector.score = 0.05

    for _ in range(2):
        with pytest.raises(PermissionError):
            auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")
    with pytest.raises(LoginRateLimited):
        auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.1")

    # alice from 10.0.0.2 is a different bucket.
    with pytest.raises(PermissionError):
        auth.login(user_id="alice", audio_bytes=wav, ip="10.0.0.2")


# -----------------------------------------------------------------------------
# E2E via FastAPI TestClient
# -----------------------------------------------------------------------------


def test_e2e_429_carries_retry_after_header():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import dependencies, routes

    auth, verification, _, detector, _ = _make_auth(
        max_attempts=2, lockout_seconds=120
    )
    wav = _enrol(verification)
    detector.score = 0.05

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_auth_service] = lambda: auth
    app.include_router(routes.router)
    client = TestClient(app)

    # Two failed logins (PermissionError → 401)
    for _ in range(2):
        resp = client.post(
            "/auth/login",
            data={"user_id": "alice"},
            files={"audio": ("login.wav", wav, "audio/wav")},
        )
        assert resp.status_code == 401, resp.text

    # Third login → 429 with Retry-After
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 429, resp.text
    assert "Retry-After" in resp.headers
    retry_after = int(resp.headers["Retry-After"])
    assert 0 < retry_after <= 120
    body = resp.json()
    assert body["retry_after_seconds"] == retry_after


def test_e2e_x_forwarded_for_extracted_for_proxied_clients():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api import dependencies, routes

    auth, verification, store, detector, _ = _make_auth(max_attempts=2)
    wav = _enrol(verification)
    detector.score = 0.05

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_auth_service] = lambda: auth
    app.include_router(routes.router)
    client = TestClient(app)

    # Two failures from the proxied IP 192.0.2.10
    for _ in range(2):
        client.post(
            "/auth/login",
            data={"user_id": "alice"},
            files={"audio": ("login.wav", wav, "audio/wav")},
            headers={"X-Forwarded-For": "192.0.2.10, 10.0.0.1"},
        )

    # Third → 429 (lockout keyed by 192.0.2.10, not the socket peer)
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
        headers={"X-Forwarded-For": "192.0.2.10, 10.0.0.1"},
    )
    assert resp.status_code == 429

    # A different X-Forwarded-For value is a different bucket.
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
        headers={"X-Forwarded-For": "203.0.113.5"},
    )
    assert resp.status_code == 401  # PermissionError, not 429
