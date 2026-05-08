"""HTTP routes for enrollment, verification, and results."""

from io import BytesIO
from wave import Error as WaveError

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.api.dependencies import (
    get_auth_service,
    get_current_session,
    get_session_token,
    get_spoof_generation_service,
    get_verification_service,
)
from app.schemas import (
    AuthSessionResponse,
    EnrollmentResponse,
    HealthResponse,
    ReferenceSampleResponse,
    SessionResponse,
    SpeakerResponse,
    VerificationResponse,
)
from app.services.auth import AuthService
from app.services.spoof import SpoofGenerationService
from app.services.verification import VerificationService

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
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (WaveError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/auth/login", response_model=AuthSessionResponse)
async def login(
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    service: AuthService = Depends(get_auth_service),
) -> AuthSessionResponse:
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        return service.login(user_id=user_id, audio_bytes=payload, filename=audio.filename)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (WaveError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (WaveError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/auth/session", response_model=SessionResponse)
def current_session(session: SessionResponse = Depends(get_current_session)) -> SessionResponse:
    return session


@router.post("/auth/refresh", response_model=SessionResponse)
def refresh_session(
    session_token: str = Depends(get_session_token),
    service: AuthService = Depends(get_auth_service),
) -> SessionResponse:
    """F2.1 — rotate the session token + extend the idle window.

    The client sends its current Bearer token; on success it receives a NEW
    token + the new expiry. The old token is invalidated atomically. The
    frontend's `lib/api.ts` request helper catches a 401 and tries this
    endpoint once before giving up.
    """
    try:
        return service.refresh_session(session_token)
    except PermissionError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


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
    session_token: str = Depends(get_session_token),
    service: AuthService = Depends(get_auth_service),
) -> None:
    service.logout(session_token)


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
