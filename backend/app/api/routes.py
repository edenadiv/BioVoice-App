"""HTTP routes for enrollment, verification, deepfake-lab spoof
generation, and operator profile management.

Public surface only — no auth, no sessions. Operator-controlled
deployment; all routes are intentionally accessible to anyone reaching
the kiosk's network.
"""

from datetime import datetime, timezone
from io import BytesIO
from wave import Error as WaveError

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse

from app.api.dependencies import (
    get_container,
    get_spoof_generation_service,
    get_verification_service,
)
from app.core.metrics import metrics
from app.schemas import (
    EnrollmentResponse,
    HealthResponse,
    SpeakerResponse,
    SpoofTestResponse,
    VerificationResponse,
)
from app.services.audio import NoSpeechDetectedError
from app.services.spoof import SpoofGenerationService
from app.services.verification import VerificationService


router = APIRouter()


# -----------------------------------------------------------------------------
# Health / readiness / metrics
# -----------------------------------------------------------------------------


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness probe — returns 200 once the app process is accepting
    connections. Use /readyz for the deep check (DB + model files)."""
    return HealthResponse(status="ok")


@router.get("/metrics", response_class=Response)
def prometheus_metrics() -> Response:
    """Prometheus exposition endpoint — public by default; gate at the
    reverse proxy if Prometheus runs on a separate network."""
    return Response(content=metrics.render(), media_type="text/plain; version=0.0.4")


@router.get("/metrics/summary")
def metrics_summary() -> dict:
    """Compact JSON snapshot for the kiosk Console panel.

    Returns real verification throughput / p50 latency / uptime derived
    from the live metrics registry. Replaces the panel's old hardcoded
    `11ms / 62/s / 14d` decoration. Empty histogram → `p50_verify_ms`
    is null until the first /verify lands."""
    return metrics.summary()


@router.get("/readyz")
def ready(request: Request) -> dict:
    """Deep readiness probe. Returns 503 when the database is unreachable
    or the container hasn't been built. ML weight files are surfaced as
    a `models_note` rather than a hard failure — heuristic fallbacks
    keep the kiosk operational."""
    container = getattr(request.app.state, "container", None)
    if container is None:
        raise HTTPException(status_code=503, detail="Container not initialised")

    checks: dict[str, dict] = {}
    overall_ok = True

    try:
        store = container.store
        if hasattr(store, "_connection"):
            store._connection.execute("SELECT 1").fetchone()
        checks["database"] = {"ok": True}
    except Exception as exc:
        checks["database"] = {"ok": False, "error": str(exc)}
        overall_ok = False

    s = container.settings
    checks["aasist_weights"] = {"ok": s.aasist_weights_path.exists()}
    checks["redimnet_weights"] = {"ok": s.redimnet_weights_path.exists()}
    if not checks["aasist_weights"]["ok"] or not checks["redimnet_weights"]["ok"]:
        checks["models_note"] = "Weights missing — falling back to heuristic detector + encoder"

    if not overall_ok:
        raise HTTPException(status_code=503, detail={"ready": False, "checks": checks})
    return {"ready": True, "checks": checks}


# -----------------------------------------------------------------------------
# Profiles (enrolment + listing + deletion)
# -----------------------------------------------------------------------------


@router.get("/users", response_model=list[SpeakerResponse])
def list_users(service: VerificationService = Depends(get_verification_service)) -> list[SpeakerResponse]:
    return service.list_users()


@router.post("/enroll", response_model=EnrollmentResponse)
async def enroll(
    user_id: str = Form(...),
    audio: UploadFile = File(...),
    service: VerificationService = Depends(get_verification_service),
) -> EnrollmentResponse:
    """Append one enrolment sample to a profile. The first call creates
    the profile; subsequent calls grow its sample list. The verification
    pipeline becomes available once `min_enrollment_samples` (default 3)
    samples are recorded."""
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        return service.enroll(user_id=user_id, audio_bytes=payload, filename=audio.filename)
    # NoSpeechDetectedError + SampleQualityRejectedError are ValueError
    # subclasses; both map to 400 with the operator-friendly message.
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/users/{user_id}", status_code=204)
def delete_user(
    user_id: str,
    request: Request,
) -> None:
    """Soft-delete a profile. Verification history rows are preserved;
    the profile is moved to `deleted_users` so an operator can audit
    removals + (with a follow-up restore tool) re-enrol."""
    container = get_container(request)
    success = container.store.soft_delete_speaker(
        user_id, deleted_by="operator", deleted_at=datetime.now(timezone.utc)
    )
    if not success:
        raise HTTPException(status_code=404, detail=f"User '{user_id}' not found")


# -----------------------------------------------------------------------------
# Verification
# -----------------------------------------------------------------------------


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
        with metrics.histogram("biovoice_verify_seconds").time():
            result = service.verify(user_id=user_id, audio_bytes=payload, filename=audio.filename)
        metrics.counter("biovoice_verifications_total").inc(
            labels={"decision": result.decision}
        )
        return result
    except NoSpeechDetectedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (WaveError, RuntimeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/results", response_model=list[VerificationResponse])
def list_results(service: VerificationService = Depends(get_verification_service)) -> list[VerificationResponse]:
    return service.list_results()


# -----------------------------------------------------------------------------
# Deepfake lab — generate a clone, then score any uploaded WAV
# -----------------------------------------------------------------------------


@router.post("/spoof")
async def generate_spoof_sample(
    target_user_id: str = Form(...),
    text: str = Form(...),
    language: str = Form("en"),
    reference_sample_id: str | None = Form(default=None),
    audio: UploadFile | None = File(default=None),
    service: SpoofGenerationService = Depends(get_spoof_generation_service),
) -> StreamingResponse:
    """Forge a deepfake clone of `target_user_id`'s enrolled voice
    speaking `text`. Returns an audio/wav blob the caller can play back
    or feed straight to /spoof/test. 503 when XTTS isn't installed."""
    payload = await audio.read() if audio is not None else None
    if payload == b"":
        raise HTTPException(status_code=400, detail="Audio file is empty")

    try:
        result = service.generate(
            user_id=target_user_id,
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


@router.post("/spoof/test", response_model=SpoofTestResponse)
async def test_spoof_sample(
    audio: UploadFile = File(...),
    service: VerificationService = Depends(get_verification_service),
) -> SpoofTestResponse:
    """Score an arbitrary uploaded WAV against AASIST + the F4
    sub-classifier. Used by the DeepfakeLab UI to test whether a
    freshly generated clone passes the deepfake gate. Same audio
    pipeline as /verify minus the speaker-similarity step — the
    question here is "is this synthetic?", not "whose voice is it?"."""
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")

    try:
        decoded = service.audio.decode_wav(payload)
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    try:
        trimmed, _ = service.audio.trim_to_voice(decoded)
    except NoSpeechDetectedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    deepfake_score = service.detector.detect(trimmed.waveform)
    # G1 / Py 3.12 float-precision defence — clamp before the value
    # reaches the Pydantic le=1.0 constraint.
    if deepfake_score < 0.0:
        deepfake_score = 0.0
    if deepfake_score > 1.0:
        deepfake_score = 1.0

    analysis_details = service.acoustic_probe.score(
        trimmed.waveform, sample_rate=trimmed.sample_rate
    )

    decision = "GENUINE" if deepfake_score >= service.deepfake_threshold else "FAKE"

    return SpoofTestResponse(
        deepfake_score=deepfake_score,
        decision=decision,
        analysis_details=analysis_details,
    )
