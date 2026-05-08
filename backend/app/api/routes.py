"""HTTP routes for enrollment, verification, and results."""

from wave import Error as WaveError

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.api.dependencies import get_auth_service, get_current_session, get_session_token, get_verification_service
from app.schemas import (
    AuthSessionResponse,
    EnrollmentResponse,
    HealthResponse,
    SessionResponse,
    SpeakerResponse,
    VerificationResponse,
)
from app.services.auth import AuthService
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


@router.delete("/auth/session", status_code=204)
def logout(
    session_token: str = Depends(get_session_token),
    service: AuthService = Depends(get_auth_service),
) -> None:
    service.logout(session_token)


@router.get("/results", response_model=list[VerificationResponse])
def list_results(service: VerificationService = Depends(get_verification_service)) -> list[VerificationResponse]:
    return service.list_results()
