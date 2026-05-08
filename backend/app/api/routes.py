"""HTTP routes for enrollment, verification, and results."""

from io import BytesIO
from wave import Error as WaveError

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

from app.api.dependencies import (
    get_auth_service,
    get_current_session,
    get_session_token,
    get_spoof_generation_service,
    get_verification_service,
)
from app.core.config import Settings, settings as default_settings
from app.schemas import (
    AuthSessionResponse,
    EnrollmentResponse,
    HealthResponse,
    ReferenceSampleResponse,
    SessionResponse,
    SpeakerResponse,
    VerificationResponse,
)
from app.services.audio import NoSpeechDetectedError, SampleQualityRejectedError
from app.services.auth import AuthService
from app.services.rate_limit import LoginRateLimited
from app.services.spoof import SpoofGenerationService
from app.services.verification import VerificationService


def _client_ip(request: Request) -> str:
    """Extract the source IP. Honours `X-Forwarded-For` (left-most entry) when
    behind a reverse proxy, else falls back to the socket peer."""
    forwarded = request.headers.get("x-forwarded-for", "").strip()
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def _settings_for(request: Request) -> Settings:
    """F2.5 — pull settings from the live container when wired up by
    `app/main.py`, else fall back to the module-level singleton. The fallback
    keeps unit tests that build a bare FastAPI() app (no container on
    `app.state`) working without test-side scaffolding."""
    container = getattr(request.app.state, "container", None)
    if container is not None:
        return container.settings
    return default_settings


def _set_session_cookie(
    response: Response,
    request: Request,
    token: str,
    *,
    max_age: int | None = None,
) -> None:
    """F2.5 — write the session token as an HttpOnly + SameSite=Strict cookie.
    `Secure` is on by default; flipped via BIOVOICE_COOKIE_INSECURE=1 for HTTP
    local dev. `max_age` matches the AuthService's idle window so the browser
    won't keep a token past the server's deadline. Callers pass it from
    `auth_service.idle_seconds` so the cookie expiry stays in lockstep with
    the session expiry the auth service writes to the store."""
    settings = _settings_for(request)
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=max_age if max_age is not None else settings.session_idle_seconds,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="strict",
        path="/",
    )


def _clear_session_cookie(response: Response, request: Request) -> None:
    settings = _settings_for(request)
    response.delete_cookie(
        key=settings.session_cookie_name,
        path="/",
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="strict",
    )

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/users", response_model=list[SpeakerResponse])
def list_users(service: VerificationService = Depends(get_verification_service)) -> list[SpeakerResponse]:
    return service.list_users()


@router.post("/enroll", response_model=EnrollmentResponse)
async def enroll(
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    service: VerificationService = Depends(get_verification_service),
) -> EnrollmentResponse:
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        return service.enroll(user_id=user_id, audio_bytes=payload, filename=audio.filename)
    # NoSpeechDetectedError is a ValueError subclass; the broader handler
    # below already maps both to 400 with the human-readable message.
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/verify", response_model=VerificationResponse)
async def verify(
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    service: VerificationService = Depends(get_verification_service),
) -> VerificationResponse:
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        return service.verify(user_id=user_id, audio_bytes=payload, filename=audio.filename)
    except NoSpeechDetectedError as exc:
        # F3.2 — VAD found no usable speech. 400, not 404 (not a missing
        # user), and not 500 (the user didn't speak — recoverable on retry).
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (WaveError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/auth/login", response_model=AuthSessionResponse)
async def login(
    request: Request,
    response: Response,
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    service: AuthService = Depends(get_auth_service),
):
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    ip = _client_ip(request)
    try:
        result = service.login(
            user_id=user_id, audio_bytes=payload, filename=audio.filename, ip=ip
        )
    except LoginRateLimited as exc:
        # F2.2 — locked out. Return 429 with Retry-After so the frontend can
        # render a real countdown.
        return JSONResponse(
            status_code=429,
            content={"detail": str(exc), "retry_after_seconds": exc.retry_after_seconds},
            headers={"Retry-After": str(exc.retry_after_seconds)},
        )
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except NoSpeechDetectedError as exc:
        # F3.2 — silent recording is a 400, not a 404. Login attempt is
        # still recorded as a failure by AuthService for rate-limit accounting.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (WaveError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # F2.5 — pin the rotated token in an HttpOnly cookie. The body still
    # carries the token so legacy Bearer clients (curl, k6, Bearer-only test
    # tooling) keep working. The frontend ignores the body token and reads
    # only the cookie.
    _set_session_cookie(
        response, request, result.session.session_token, max_age=service.idle_seconds
    )
    return result


@router.post("/me/enroll", response_model=EnrollmentResponse)
async def enroll_current_user(
    audio: UploadFile = File(...),
    session: SessionResponse = Depends(get_current_session),
    service: VerificationService = Depends(get_verification_service),
) -> EnrollmentResponse:
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        return service.enroll(user_id=session.user_id, audio_bytes=payload, filename=audio.filename)
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/me/verify", response_model=VerificationResponse)
async def verify_current_user(
    audio: UploadFile = File(...),
    session: SessionResponse = Depends(get_current_session),
    service: VerificationService = Depends(get_verification_service),
) -> VerificationResponse:
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        return service.verify(user_id=session.user_id, audio_bytes=payload, filename=audio.filename)
    except NoSpeechDetectedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (WaveError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/auth/session", response_model=SessionResponse)
def current_session(session: SessionResponse = Depends(get_current_session)) -> SessionResponse:
    return session


@router.post("/auth/refresh", response_model=SessionResponse)
def refresh_session(
    request: Request,
    response: Response,
    session_token: str = Depends(get_session_token),
    service: AuthService = Depends(get_auth_service),
) -> SessionResponse:
    """F2.1 — rotate the session token + extend the idle window.

    The client sends its current cookie (or legacy Bearer token); on success
    the rotated token is written back as a fresh HttpOnly cookie and the
    response body carries the new expiry. The old token is invalidated
    atomically. `lib/api.ts` triggers this on a 401.
    """
    try:
        rotated = service.refresh_session(session_token)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc

    _set_session_cookie(
        response, request, rotated.session_token, max_age=service.idle_seconds
    )
    return rotated


@router.get("/me/reference-samples", response_model=list[ReferenceSampleResponse])
def list_current_user_reference_samples(
    session: SessionResponse = Depends(get_current_session),
    service: SpoofGenerationService = Depends(get_spoof_generation_service),
) -> list[ReferenceSampleResponse]:
    return service.list_reference_samples(session.user_id)


@router.post("/me/spoof")
async def generate_spoof_sample(
    text: str = Form(...),
    language: str = Form("en"),
    reference_sample_id: str | None = Form(default=None),
    audio: UploadFile | None = File(default=None),
    session: SessionResponse = Depends(get_current_session),
    service: SpoofGenerationService = Depends(get_spoof_generation_service),
) -> StreamingResponse:
    payload = await audio.read() if audio is not None else None
    if payload == b"":
        raise HTTPException(status_code=400, detail="Audio file is empty")

    try:
        result = service.generate(
            user_id=session.user_id,
            text=text,
            language=language,
            reference_sample_id=reference_sample_id,
            reference_audio_bytes=payload,
            reference_filename=audio.filename if audio is not None else None,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    return StreamingResponse(
        BytesIO(result.audio_bytes),
        media_type="audio/wav",
        headers={
            "Content-Disposition": f'attachment; filename="{result.file_name}"',
            "X-Spoof-Source": result.source_description,
        },
    )


@router.delete("/auth/session", status_code=204)
def logout(
    request: Request,
    response: Response,
    session_token: str = Depends(get_session_token),
    service: AuthService = Depends(get_auth_service),
) -> None:
    service.logout(session_token)
    # F2.5 — clear the cookie even if the token was already gone server-side,
    # so the browser doesn't keep retrying with a stale value.
    _clear_session_cookie(response, request)


@router.get("/me/verifications/{result_id}", response_model=VerificationResponse)
def get_current_user_verification(
    result_id: str,
    session: SessionResponse = Depends(get_current_session),
    service: VerificationService = Depends(get_verification_service),
) -> VerificationResponse:
    response = service.get_result(user_id=session.user_id, result_id=result_id)
    if response is None:
        raise HTTPException(status_code=404, detail="Verification result not found")
    return response


@router.get("/results", response_model=list[VerificationResponse])
def list_results(service: VerificationService = Depends(get_verification_service)) -> list[VerificationResponse]:
    return service.list_results()
