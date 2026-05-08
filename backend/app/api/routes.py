"""HTTP routes for enrollment, verification, and results."""

import hashlib
import re
from io import BytesIO
from wave import Error as WaveError

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.api.dependencies import (
    get_auth_service,
    get_current_session,
    get_detector_service,
    get_session_token,
    get_spoof_generation_service,
    get_verification_service,
)
from app.schemas import (
    AuthSessionResponse,
    AvailabilityResponse,
    EnrollmentResponse,
    HealthResponse,
    ReferenceSampleResponse,
    SessionResponse,
    SpeakerResponse,
    SpoofTestResponse,
    VerificationResponse,
)
from app.services.auth import AuthService
from app.services.detector import DeepfakeDetectorService, analysis_details_from_score
from app.services.audio import AudioService
from app.services.spoof import SpoofGenerationService
from app.services.verification import VerificationService

router = APIRouter()

USER_ID_PATTERN = re.compile(r"^[a-zA-Z0-9_\-\.]{3,32}$")


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")


@router.get("/users", response_model=list[SpeakerResponse])
def list_users(service: VerificationService = Depends(get_verification_service)) -> list[SpeakerResponse]:
    return service.list_users()


@router.get("/users/{user_id}/availability", response_model=AvailabilityResponse)
def check_user_availability(
    user_id: str,
    service: VerificationService = Depends(get_verification_service),
) -> AvailabilityResponse:
    if not USER_ID_PATTERN.match(user_id):
        raise HTTPException(
            status_code=422,
            detail="user_id must be 3-32 chars (letters, digits, _, -, .)",
        )
    return AvailabilityResponse(available=service.is_user_id_available(user_id))


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


@router.post("/me/spoof/test", response_model=SpoofTestResponse)
async def test_spoof_audio(
    audio: UploadFile = File(...),
    session: SessionResponse = Depends(get_current_session),
    detector: DeepfakeDetectorService = Depends(get_detector_service),
    service: VerificationService = Depends(get_verification_service),
) -> SpoofTestResponse:
    """Run AASIST against an uploaded WAV. Used by DeepfakeLab "Test Detection".

    No verification, no enrollment lookup; latency budget < 200 ms.
    """
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")

    audio_service = AudioService(target_sample_rate=service.sample_rate)
    try:
        decoded = audio_service.decode_wav(payload)
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    score = detector.detect(decoded.waveform)
    audio_hash = hashlib.sha256(payload).hexdigest()
    decision = "FAKE" if score < service.deepfake_threshold else "GENUINE"
    return SpoofTestResponse(
        deepfake_score=score,
        decision=decision,
        analysis_details=analysis_details_from_score(score, audio_hash=audio_hash),
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
