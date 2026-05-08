"""FastAPI dependency helpers."""

from fastapi import Depends, Header, HTTPException, Request

from app.core.container import AppContainer
from app.schemas import SessionResponse
from app.services.audit import AuditService
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


def get_audit_service(request: Request) -> AuditService:
    return get_container(request).audit_service


def require_admin_key(
    request: Request,
    x_admin_api_key: str | None = Header(default=None, alias="X-Admin-API-Key"),
) -> None:
    """F6 — admin routes are inaccessible unless `BIOVOICE_ADMIN_API_KEY` is
    set in the environment AND the caller presents the matching value via
    the `X-Admin-API-Key` header. Unset secret → 503 (the surface is
    explicitly disabled). Wrong / missing header → 401."""
    container = getattr(request.app.state, "container", None)
    expected = container.settings.admin_api_key if container is not None else None
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="Admin endpoints are disabled. Set BIOVOICE_ADMIN_API_KEY to enable.",
        )
    if not x_admin_api_key or x_admin_api_key != expected:
        raise HTTPException(status_code=401, detail="Invalid admin API key")


def get_session_token(
    request: Request,
    authorization: str | None = Header(default=None),
) -> str:
    """F2.5 — accept the session token from either the cookie OR the legacy
    Authorization Bearer header. Cookie takes precedence so a refreshed
    cookie always wins over a stale header.

    Production clients (post-F2.5 frontend) send only the cookie. Bearer
    support stays for tooling (curl, pytest, k6 load tests).
    """
    container = getattr(request.app.state, "container", None)
    cookie_name = (
        container.settings.session_cookie_name
        if container is not None
        else "biovoice_session"
    )
    cookie_token = request.cookies.get(cookie_name)
    if cookie_token:
        return cookie_token
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
