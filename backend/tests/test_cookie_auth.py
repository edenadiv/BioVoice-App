"""F2.5 — HTTPS-aware cookie session tests.

Exercises the cookie surface end-to-end via FastAPI TestClient:
  - Login sets a cookie with HttpOnly + SameSite=Strict + the right name.
  - Authed requests succeed via the cookie alone (no Authorization header).
  - Legacy Bearer header still works for tooling/curl/k6.
  - Cookie wins when both are presented (rotation safety).
  - Refresh rotates the cookie value.
  - Logout clears the cookie (browser drops it on next request).
  - `Secure` flag is OFF when BIOVOICE_COOKIE_INSECURE=1 (HTTP local dev).
"""

from __future__ import annotations

import importlib

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import dependencies, routes
from app.services.auth import AuthService
from app.services.verification import VerificationService
from app.storage.memory_store import MemoryStore

from .conftest import HashEncoder, SAMPLE_RATE, StubDetector, make_wav


# -----------------------------------------------------------------------------
# Test harness — bare FastAPI app with overridden service dependencies.
# Mirrors the harness in test_auth_session.py for consistency.
# -----------------------------------------------------------------------------


def _build_app(idle_seconds: int = 600) -> tuple[TestClient, AuthService, VerificationService, MemoryStore]:
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
    auth = AuthService(store=store, verification_service=verification, idle_seconds=idle_seconds)

    app = FastAPI()
    app.dependency_overrides[dependencies.get_verification_service] = lambda: verification
    app.dependency_overrides[dependencies.get_auth_service] = lambda: auth
    app.include_router(routes.router)
    # F2.5 — Secure cookies are dropped by httpx on http://testserver. Use
    # https:// so the cookie jar persists them across requests, matching the
    # production scheme.
    return TestClient(app, base_url="https://testserver"), auth, verification, store


def _enrol(verification: VerificationService) -> bytes:
    wav = make_wav(2.0)
    for _ in range(3):
        verification.enroll(user_id="alice", audio_bytes=wav, filename="enrol.wav")
    return wav


def _login(client: TestClient, wav: bytes) -> str:
    """Hit /auth/login with form data; return the rotated cookie value (or
    raise if missing)."""
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 200, resp.text
    cookie = resp.cookies.get("biovoice_session")
    assert cookie is not None, "login should set the biovoice_session cookie"
    return cookie


# -----------------------------------------------------------------------------
# Cookie attributes on /auth/login
# -----------------------------------------------------------------------------


def test_login_sets_httponly_strict_cookie():
    client, _, verification, _ = _build_app()
    wav = _enrol(verification)
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 200, resp.text
    set_cookie = resp.headers.get("set-cookie", "")
    assert "biovoice_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    # `samesite=Strict` is what FastAPI/Starlette emit (case-insensitive
    # per RFC 6265bis, but we assert the literal Starlette emission so any
    # accidental flag-removal stands out).
    assert "samesite=strict" in set_cookie.lower()
    # Path is set to `/` so the cookie covers /me/* and /auth/*.
    assert "path=/" in set_cookie.lower()
    # `Secure` is on by default — the test runs without
    # BIOVOICE_COOKIE_INSECURE so the flag must be present.
    assert "secure" in set_cookie.lower()


def test_login_cookie_max_age_matches_idle_window():
    client, _, verification, _ = _build_app(idle_seconds=900)
    wav = _enrol(verification)
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 200
    set_cookie = resp.headers.get("set-cookie", "").lower()
    assert "max-age=900" in set_cookie


# -----------------------------------------------------------------------------
# Cookie wins for /me/* — no Authorization header required
# -----------------------------------------------------------------------------


def test_authed_request_succeeds_with_cookie_only():
    client, _, verification, _ = _build_app()
    wav = _enrol(verification)
    cookie = _login(client, wav)

    # TestClient automatically forwards cookies on subsequent requests when
    # using the same client; assert via the cookie jar.
    assert client.cookies.get("biovoice_session") == cookie

    resp = client.get("/auth/session")
    assert resp.status_code == 200, resp.text
    assert resp.json()["user_id"] == "alice"


def test_authed_request_succeeds_with_bearer_only_legacy():
    """Bearer header still works — used by curl, k6, pytest tooling."""
    client, _, verification, _ = _build_app()
    wav = _enrol(verification)
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    body_token = resp.json()["session"]["session_token"]

    # Drop the cookie that TestClient picked up so we exercise the Bearer
    # path in isolation.
    client.cookies.clear()

    resp = client.get(
        "/auth/session",
        headers={"Authorization": f"Bearer {body_token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["session_token"] == body_token


def test_cookie_wins_over_stale_bearer_header():
    """When a client sends a (stale) Bearer + a (fresh) cookie, the cookie
    must win — otherwise refresh-rotation can't recover stuck clients."""
    client, _, verification, _ = _build_app()
    wav = _enrol(verification)

    # Issue a token, rotate it, and present the OLD token via the Bearer
    # header alongside the rotated cookie. Cookie should be honoured.
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 200
    stale_bearer = resp.json()["session"]["session_token"]

    # Refresh — this rotates the cookie value AND invalidates `stale_bearer`.
    resp = client.post("/auth/refresh")
    assert resp.status_code == 200
    fresh_cookie = client.cookies.get("biovoice_session")
    assert fresh_cookie is not None and fresh_cookie != stale_bearer

    resp = client.get(
        "/auth/session",
        headers={"Authorization": f"Bearer {stale_bearer}"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["session_token"] == fresh_cookie


# -----------------------------------------------------------------------------
# Refresh rotates the cookie
# -----------------------------------------------------------------------------


def test_refresh_rotates_cookie_value():
    client, _, verification, _ = _build_app()
    wav = _enrol(verification)
    initial = _login(client, wav)

    resp = client.post("/auth/refresh")
    assert resp.status_code == 200, resp.text
    rotated = client.cookies.get("biovoice_session")
    assert rotated is not None
    assert rotated != initial
    # Body advertises the new token too (handy for non-cookie clients).
    assert resp.json()["session_token"] == rotated


# -----------------------------------------------------------------------------
# Logout clears the cookie
# -----------------------------------------------------------------------------


def test_logout_clears_cookie():
    client, _, verification, _ = _build_app()
    wav = _enrol(verification)
    _login(client, wav)

    resp = client.delete("/auth/session")
    assert resp.status_code == 204
    set_cookie = resp.headers.get("set-cookie", "").lower()
    # Starlette signals deletion via `max-age=0` and a stale `expires=`.
    assert "biovoice_session=" in set_cookie
    assert "max-age=0" in set_cookie

    # Subsequent unauth'd request fails.
    client.cookies.clear()
    resp = client.get("/auth/session")
    assert resp.status_code == 401


# -----------------------------------------------------------------------------
# `Secure` flag toggled by env (BIOVOICE_COOKIE_INSECURE=1 → off)
# -----------------------------------------------------------------------------


def test_secure_flag_off_when_insecure_env_set(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("BIOVOICE_COOKIE_INSECURE", "1")

    # Settings reads BIOVOICE_COOKIE_INSECURE at construction time; reload
    # the module so the new env value takes effect.
    from app.core import config as config_module

    importlib.reload(config_module)
    importlib.reload(routes)  # routes imports `default_settings`

    client, _, verification, _ = _build_app()
    wav = _enrol(verification)
    resp = client.post(
        "/auth/login",
        data={"user_id": "alice"},
        files={"audio": ("login.wav", wav, "audio/wav")},
    )
    assert resp.status_code == 200
    set_cookie = resp.headers.get("set-cookie", "").lower()
    assert "biovoice_session=" in set_cookie
    assert "secure" not in set_cookie

    # Clean up: restore default behaviour for other tests in this run.
    monkeypatch.delenv("BIOVOICE_COOKIE_INSECURE", raising=False)
    importlib.reload(config_module)
    importlib.reload(routes)
