"""Session-oriented authentication service."""

from __future__ import annotations

from typing import Protocol
from uuid import uuid4

from app.models import SessionRecord
from app.schemas import AuthSessionResponse, SessionResponse
from app.services.verification import VerificationService


class SessionStore(Protocol):
    def put_session(self, record: SessionRecord) -> None: ...

    def get_session(self, session_token: str) -> SessionRecord | None: ...

    def delete_session(self, session_token: str) -> None: ...


class AuthService:
    def __init__(self, store: SessionStore, verification_service: VerificationService):
        self.store = store
        self.verification_service = verification_service

    def login(self, user_id: str, audio_bytes: bytes, filename: str | None = None) -> AuthSessionResponse:
        verification = self.verification_service.verify(user_id=user_id, audio_bytes=audio_bytes, filename=filename)
        if verification.decision != "ACCEPT":
            raise PermissionError("Voice authentication failed")

        session = SessionRecord(session_token=str(uuid4()), user_id=user_id)
        self.store.put_session(session)
        return AuthSessionResponse(
            session=SessionResponse(
                session_token=session.session_token,
                user_id=session.user_id,
                created_at=session.created_at,
            ),
            verification=verification,
        )

    def get_session(self, session_token: str) -> SessionResponse:
        record = self.store.get_session(session_token)
        if record is None:
            raise PermissionError("Session not found")
        return SessionResponse(
            session_token=record.session_token,
            user_id=record.user_id,
            created_at=record.created_at,
        )

    def logout(self, session_token: str) -> None:
        self.store.delete_session(session_token)
