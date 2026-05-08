"""FastAPI dependency helpers."""

from fastapi import Depends, Header, HTTPException, Request

from app.core.container import AppContainer
from app.schemas import SessionResponse
from app.services.auth import AuthService
from app.services.spoof import SpoofGenerationService
from app.services.verification import VerificationService


def get_container(request: Request) -> AppContainer:
    container = getattr(request.app.state, "container", None)
    if container is None:
        raise HTTPException(status_code=500, detail="Application container unavailable")
    return container


def get_verification_service(request: Request) -> VerificationService:
    return get_container(request).verification_service


def get_auth_service(request: Request) -> AuthService:
    return get_container(request).auth_service


def get_spoof_generation_service(request: Request) -> SpoofGenerationService:
    return get_container(request).spoof_service


def get_session_token(authorization: str | None = Header(default=None)) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Invalid Authorization header")
    return token


def get_current_session(
    session_token: str = Depends(get_session_token),
    auth_service: AuthService = Depends(get_auth_service),
) -> SessionResponse:
    try:
        return auth_service.get_session(session_token)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
