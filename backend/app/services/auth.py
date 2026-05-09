"""Session-oriented authentication service."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Protocol
from uuid import uuid4

from app.models import SessionRecord
from app.schemas import AuthSessionResponse, SessionResponse
from app.services.audit import AuditService
from app.services.rate_limit import LoginRateLimiter
from app.services.verification import VerificationService


class SessionStore(Protocol):
    def put_session(self, record: SessionRecord) -> None: ...

    def get_session(self, session_token: str) -> SessionRecord | None: ...

    def delete_session(self, session_token: str) -> None: ...


class AuthService:
    def __init__(
        self,
        store: SessionStore,
        verification_service: VerificationService,
        *,
        idle_seconds: int = 30 * 60,
        rate_limiter: LoginRateLimiter | None = None,
        audit_service: AuditService | None = None,
    ):
        """`idle_seconds` is the rolling expiry window. Defaults to 30 minutes;
        production passes `Settings.session_idle_seconds` from `core/config.py`.

        `rate_limiter` (F2.2) gates `/auth/login` by (user_id, source IP). When
        omitted, no rate limiting is applied — useful in unit tests that
        exercise other paths.
        """
        self.store = store
        self.verification_service = verification_service
        self.idle_seconds = idle_seconds
        self.rate_limiter = rate_limiter
        # F6.2 — optional audit hook. None in unit tests that don't care.
        self.audit_service = audit_service

    # F2.1 — Session lifecycle
    # =========================================================================

    def login(
        self,
        user_id: str,
        audio_bytes: bytes,
        filename: str | None = None,
        *,
        ip: str = "unknown",
    ) -> AuthSessionResponse:
        # F2.2 — rate-limit gate runs BEFORE the (expensive) verify call so
        # brute-force attempts pay no model cost. Raises LoginRateLimited
        # which the route maps to HTTP 429 + Retry-After.
        if self.rate_limiter is not None:
            self.rate_limiter.check(user_id, ip)

        try:
            verification = self.verification_service.verify(
                user_id=user_id, audio_bytes=audio_bytes, filename=filename
            )
        except Exception:
            # Errors in verify (e.g. user not enrolled, sample count too low)
            # also count as failures so attackers can't probe enrolment state
            # for free.
            if self.rate_limiter is not None:
                self.rate_limiter.record_failure(user_id, ip)
            raise

        if verification.decision != "ACCEPT":
            if self.rate_limiter is not None:
                self.rate_limiter.record_failure(user_id, ip)
            self._audit("login.fail", user_id=user_id, ip=ip, reason=verification.decision_reason)
            raise PermissionError("Voice authentication failed")

        # Successful login → reset the rate-limit counters for this pair.
        if self.rate_limiter is not None:
            self.rate_limiter.record_success(user_id, ip)
        self._audit("login.success", user_id=user_id, ip=ip)

        now = datetime.now(timezone.utc)
        session = SessionRecord(
            session_token=str(uuid4()),
            user_id=user_id,
            created_at=now,
            expires_at=now + timedelta(seconds=self.idle_seconds),
            last_seen_at=now,
        )
        self.store.put_session(session)
        return AuthSessionResponse(
            session=self._to_response(session),
            verification=verification,
        )

    def get_session(self, session_token: str) -> SessionResponse:
        """Look up a session by token. Raises:
          - PermissionError("Session not found") if the token is unknown
          - PermissionError("Session expired") if the deadline has passed

        On success, bumps `last_seen_at` and rolls `expires_at` forward by the
        idle window. Persisted via `put_session` so concurrent workers see the
        refreshed expiry.
        """
        record = self.store.get_session(session_token)
        if record is None:
            raise PermissionError("Session not found")
        now = datetime.now(timezone.utc)
        if now > record.expires_at:
            # Best-effort cleanup; ignore errors (the next login will overwrite).
            try:
                self.store.delete_session(session_token)
            except Exception:
                pass
            raise PermissionError("Session expired")

        record.last_seen_at = now
        record.expires_at = now + timedelta(seconds=self.idle_seconds)
        self.store.put_session(record)
        return self._to_response(record)

    def refresh_session(self, session_token: str) -> SessionResponse:
        """Rotate the session token AND extend the expiry. Used by `POST
        /auth/refresh` so an active client can keep working past the idle
        window without re-authenticating with their voice.

        Note: rotating the token defends against session-fixation. The new
        token is unique per refresh; the old one is invalidated.
        """
        record = self.store.get_session(session_token)
        if record is None:
            raise PermissionError("Session not found")
        now = datetime.now(timezone.utc)
        if now > record.expires_at:
            try:
                self.store.delete_session(session_token)
            except Exception:
                pass
            raise PermissionError("Session expired")

        # Issue a new token; invalidate the old one.
        rotated = SessionRecord(
            session_token=str(uuid4()),
            user_id=record.user_id,
            created_at=record.created_at,
            expires_at=now + timedelta(seconds=self.idle_seconds),
            last_seen_at=now,
        )
        self.store.put_session(rotated)
        try:
            self.store.delete_session(session_token)
        except Exception:
            pass
        return self._to_response(rotated)

    def logout(self, session_token: str) -> None:
        record = self.store.get_session(session_token)
        self.store.delete_session(session_token)
        if record is not None:
            self._audit("logout", user_id=record.user_id)

    def _audit(self, action: str, *, user_id: str, ip: str | None = None, **extra) -> None:
        if self.audit_service is None:
            return
        self.audit_service.record(
            action,
            actor=user_id,
            ip=ip,
            target=user_id,
            metadata=extra or None,
        )

    def _to_response(self, record: SessionRecord) -> SessionResponse:
        return SessionResponse(
            session_token=record.session_token,
            user_id=record.user_id,
            created_at=record.created_at,
            expires_at=record.expires_at,
        )
