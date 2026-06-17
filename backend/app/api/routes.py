"""HTTP routes for enrollment, verification, deepfake-lab spoof
generation, and operator profile management.

Public surface only — no auth, no sessions. Operator-controlled
deployment; all routes are intentionally accessible to anyone reaching
the kiosk's network.
"""

import base64
from datetime import datetime, timezone
from io import BytesIO
from wave import Error as WaveError

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import StreamingResponse

from app.api.dependencies import (
    get_container,
    get_spoof_generation_service,
    get_verification_service,
)
from app.core.metrics import metrics
from app.schemas import (
    CamFaithfulnessResponse,
    CamFaithModel,
    ConfigPatch,
    ConfigResponse,
    EmbedResponse,
    EnrollmentResponse,
    ExplainResponse,
    HealthResponse,
    IdentificationResponse,
    LogDetailResponse,
    LogEntry,
    SpeakerResponse,
    SpoofBatchCandidate,
    SpoofBatchRequest,
    SpoofBatchResponse,
    SpoofEngineInfo,
    SpoofEnginesResponse,
    SpoofTestResponse,
    SpoofVoice,
    UserEmbedding,
    VerificationResponse,
    SpeakerModelKey,
)
from app.services import runtime_config
from app.services.audio import NoSpeechDetectedError
from app.services.explain import (
    SAMPLE_RATE as EXPLAIN_SAMPLE_RATE,
    _build_axes as build_explain_axes,
    build_adapters,
    cam_topk_masks,
    explain_model,
    input_spectrogram,
    random_frame_mask,
    splice_by_frame_mask,
)
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
    checks["cluster_models"] = {"ok": s.cluster_models_path.is_dir()}
    checks["redimnet_weights"] = {"ok": s.redimnet_weights_path.exists()}
    if not checks["cluster_models"]["ok"] or not checks["redimnet_weights"]["ok"]:
        checks["models_note"] = "Models missing — falling back to heuristic detector + encoder"

    if not overall_ok:
        raise HTTPException(status_code=503, detail={"ready": False, "checks": checks})
    return {"ready": True, "checks": checks}


# -----------------------------------------------------------------------------
# Profiles (enrolment + listing + deletion)
# -----------------------------------------------------------------------------


@router.get("/users", response_model=list[SpeakerResponse])
def list_users(service: VerificationService = Depends(get_verification_service)) -> list[SpeakerResponse]:
    return service.list_users()


@router.get("/users/embeddings", response_model=list[UserEmbedding])
def list_user_embeddings(
    model_key: SpeakerModelKey = Query(default="redimnet_b5"),
    service: VerificationService = Depends(get_verification_service),
) -> list[UserEmbedding]:
    """V1 — bulk dump of every enrolled profile's centroid + per-sample
    192-d embeddings. Feeds the operator-console EmbeddingConstellation
    so it can render real PCA(3) projections instead of the previous
    deterministic-hash placeholders."""
    return service.list_user_embeddings(model_key=model_key)


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


@router.post("/embed", response_model=EmbedResponse)
async def embed_audio(
    audio: UploadFile = File(...),
    model_key: SpeakerModelKey = Form(default="redimnet_b5"),
    service: VerificationService = Depends(get_verification_service),
) -> EmbedResponse:
    """V1 — encoder-only pass for the constellation's live point.

    Takes an arbitrary uploaded WAV, returns the 192-d ReDimNet
    embedding plus duration + SNR. Deliberately does NOT write to the
    DB, call the deepfake detector, or bump verification metrics —
    this is a pure stateless preview the frontend posts a few times
    per second while the operator's mic is hot."""
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        return service.embed_only(audio_bytes=payload, model_key=model_key)
    except NoSpeechDetectedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/identify", response_model=IdentificationResponse)
async def identify(
    audio: UploadFile = File(...),
    top_n: int | None = Form(default=None, ge=1, le=20),
    service: VerificationService = Depends(get_verification_service),
) -> IdentificationResponse:
    """Open-set "most similar" — score the input WAV against every
    enrolled centroid and return the ranked top-N. Doesn't require a
    user_id; returns the system's best guess at who the speaker is.

    `top_n` defaults to the runtime-configured value (PATCH /config) when
    the caller omits it. Errors: 400 on empty / unspeechy / undecodable
    audio; 404 when no users are enrolled."""
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        return service.identify(audio_bytes=payload, top_n=top_n)
    except NoSpeechDetectedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        # "No users enrolled" — surface as 404 so the caller can show
        # the empty-state message instead of a generic 500.
        if "No users enrolled" in str(exc):
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/results", response_model=list[VerificationResponse])
def list_results(service: VerificationService = Depends(get_verification_service)) -> list[VerificationResponse]:
    return service.list_results()


# -----------------------------------------------------------------------------
# Logs — unified verify + identify run history
# -----------------------------------------------------------------------------


@router.get("/logs", response_model=list[LogEntry])
def list_logs(service: VerificationService = Depends(get_verification_service)) -> list[LogEntry]:
    """Every verification + identification run, newest first. Click an
    entry → GET /logs/{id} for the full result the UI re-renders."""
    return service.list_logs()


@router.get("/logs/{result_id}", response_model=LogDetailResponse)
def get_log(result_id: str, service: VerificationService = Depends(get_verification_service)) -> LogDetailResponse:
    detail = service.get_log_detail(result_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"Run '{result_id}' not found")
    return detail


@router.get("/logs/{result_id}/audio")
def get_log_audio(result_id: str, request: Request) -> StreamingResponse:
    """The captured audio for a logged run, so the detail view can re-run
    /explain and reproduce the Grad-CAM. 404 when audio wasn't retained."""
    container = get_container(request)
    audio_bytes = container.store.get_run_audio(result_id)
    if audio_bytes is None:
        raise HTTPException(status_code=404, detail="Audio not retained for this run")
    return StreamingResponse(
        BytesIO(audio_bytes),
        media_type="audio/wav",
        headers={"Content-Disposition": f'inline; filename="{result_id}.wav"'},
    )


# -----------------------------------------------------------------------------
# Runtime config — live-tunable thresholds + model participation
# -----------------------------------------------------------------------------


@router.get("/config", response_model=ConfigResponse)
def get_config(request: Request) -> ConfigResponse:
    """Effective decision thresholds + model participation, plus read-only
    context (sample rate, which models are loaded, provenance)."""
    return runtime_config.effective_config(get_container(request))


@router.patch("/config", response_model=ConfigResponse)
def patch_config(patch: ConfigPatch, request: Request) -> ConfigResponse:
    """Update thresholds / model participation on the live service and
    persist the new operating point. Bounds are enforced by ConfigPatch;
    enabling an unavailable model returns 400."""
    container = get_container(request)
    body = patch.model_dump(exclude_unset=True)
    if not body:
        return runtime_config.effective_config(container)
    try:
        return runtime_config.apply_patch(container, body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


# -----------------------------------------------------------------------------
# Explain — per-model Grad-CAM on an arbitrary WAV
# -----------------------------------------------------------------------------


@router.post("/explain", response_model=ExplainResponse)
async def explain(
    audio: UploadFile = File(...),
    user_id: str = Form(default=""),
    service: VerificationService = Depends(get_verification_service),
) -> ExplainResponse:
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        decoded = service.audio.decode_wav(payload)
        trimmed, _ = service.audio.trim_to_voice(decoded)
    except NoSpeechDetectedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    service.detector.load()
    detector_model = getattr(service.detector, "model", None)
    redimnet_model = getattr(service.encoder, "model", None)
    ecapa_encoder = service.comparison_encoders.get("ecapa_voxceleb")
    ecapa_model = getattr(ecapa_encoder, "model", None) if ecapa_encoder else None

    redimnet_centroid = None
    ecapa_centroid = None
    if user_id:
        speaker = service.store.get_speaker(user_id)
        if speaker is not None:
            redimnet_centroid = speaker.embedding
            ecapa_centroid = speaker.comparison_embeddings.get("ecapa_voxceleb")

    adapters = build_adapters(
        detector_model,
        redimnet_model,
        ecapa_model,
        redimnet_centroid=redimnet_centroid,
        ecapa_centroid=ecapa_centroid,
    )
    cams = [explain_model(key, ctx, trimmed.waveform) for key, ctx in adapters.items()]
    duration_ms = 1000.0 * len(trimmed.waveform) / EXPLAIN_SAMPLE_RATE
    times, freqs = build_explain_axes(duration_ms)
    return ExplainResponse(
        cams=cams,
        spectrogram=input_spectrogram(trimmed.waveform),
        frame_times_ms=times,
        freq_hz=freqs,
        duration_ms=duration_ms,
    )


# -----------------------------------------------------------------------------
# Explain — Grad-CAM faithfulness (sufficiency + comprehensiveness)
# -----------------------------------------------------------------------------

# Speaker models whose Grad-CAM we can mask-and-rescore. AASIST is anti-spoof
# (genuine/fake), not identity, so it's excluded from the "is this person" test.
_FAITHFULNESS_MODELS = ("redimnet_b5", "ecapa_voxceleb")

# Fraction of the clip every variant keeps (top-k by saliency). Fixed coverage
# = the cam_layer_sweep.py protocol: doesn't swing with clip length the way a
# threshold does, and gives retain enough audio to embed stably.
_FAITH_COVERAGE = 0.30
# Random-baseline masks averaged per model. Each adds 2 embeds, so keep modest.
_FAITH_SEEDS = 4
# Margin (similarity points / 100) the CAM must beat random by to "count".
_FAITH_MARGIN = 0.02


def _faith_verdict(target: str | None, testable: bool, suff: float, nec: float) -> str:
    """Verdict from beating a random region of equal coverage.

    * sufficiency > margin → CAM's kept region carries more identity than a
      random region (it localises *what to keep*).
    * necessity   > margin → removing the CAM region hurts more than removing
      a random one (it localises *what matters*).
    both ⇒ faithful; either ⇒ weak; neither ⇒ unfaithful (no better than
    chance). Identity is distributed in speaker models, so necessity is the
    hard half — most honest CAMs land on `weak`."""
    if target is None or not testable:
        return "no_salience"
    suff_ok = suff >= _FAITH_MARGIN
    nec_ok = nec >= _FAITH_MARGIN
    if suff_ok and nec_ok:
        return "faithful"
    if suff_ok or nec_ok:
        return "weak"
    return "unfaithful"


def _faith_centroid(speaker, key: str) -> list[float]:
    if speaker is None:
        return []
    if key == "redimnet_b5":
        return speaker.embedding
    return speaker.comparison_embeddings.get(key, [])


@router.post("/explain/faithfulness", response_model=CamFaithfulnessResponse)
async def explain_faithfulness(
    audio: UploadFile = File(...),
    user_id: str = Form(default=""),
    top_n: int = Form(default=3, ge=1, le=10),
    service: VerificationService = Depends(get_verification_service),
) -> CamFaithfulnessResponse:
    """Grad-CAM faithfulness check for the Identify tab (random-baseline test).

    For each speaker model, keep the top-`_FAITH_COVERAGE` fraction of frames
    by Grad-CAM saliency (`retain`) and its complement (`delete`), then score
    each against the target speaker's centroid — and against a random region
    of the same size. The CAM is faithful when its region carries more identity
    than random (sufficiency) and removing it hurts more than random
    (necessity). Fixed coverage + centroid similarity keep the verdict stable
    run-to-run, unlike a threshold + rank-vs-all."""
    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="Audio file is empty")
    try:
        decoded = service.audio.decode_wav(payload)
        trimmed, _ = service.audio.trim_to_voice(decoded)
    except NoSpeechDetectedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except (ValueError, WaveError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    n_enrolled = len(service.store.list_users())
    if n_enrolled == 0:
        raise HTTPException(status_code=404, detail="No users enrolled. Enrol at least one profile first.")

    redimnet_model = getattr(service.encoder, "model", None)
    ecapa_encoder = service.comparison_encoders.get("ecapa_voxceleb")
    ecapa_model = getattr(ecapa_encoder, "model", None) if ecapa_encoder else None

    # Target speaker = the explicit user_id if given, else the best match for
    # the full clip. Its centroid is what every masked variant is scored against.
    waveform = trimmed.waveform
    duration_ms = 1000.0 * len(waveform) / EXPLAIN_SAMPLE_RATE
    target = user_id or None
    if target is None:
        ranked = service.score_waveform(waveform, model_key="redimnet_b5", top_n=1)
        target = ranked[0].user_id if ranked else None
    target_speaker = service.store.get_speaker(target) if target else None
    if target_speaker is not None:
        target_speaker = service._ensure_comparison_embeddings(target_speaker)

    redimnet_centroid = _faith_centroid(target_speaker, "redimnet_b5")
    ecapa_centroid = _faith_centroid(target_speaker, "ecapa_voxceleb")
    adapters = build_adapters(
        None,  # AASIST excluded — identity test only
        redimnet_model,
        ecapa_model,
        redimnet_centroid=redimnet_centroid or None,
        ecapa_centroid=ecapa_centroid or None,
    )

    min_samples = int(0.1 * EXPLAIN_SAMPLE_RATE)
    coverage_pct = 0.0
    models: list[CamFaithModel] = []
    for key in _FAITHFULNESS_MODELS:
        ctx = adapters.get(key)
        centroid = _faith_centroid(target_speaker, key)
        if ctx is None or not centroid:
            continue
        masks = cam_topk_masks(ctx, waveform, _FAITH_COVERAGE, duration_ms, sample_rate=EXPLAIN_SAMPLE_RATE)
        coverage_pct = masks.coverage_pct
        testable = len(masks.retain) >= min_samples and len(masks.delete) >= min_samples
        # Only the projectable model's vectors feed the voice-space plot.
        want_vectors = key == "redimnet_b5"

        orig_emb, original_similarity = service.embed_and_compare(waveform, centroid, key)
        retain_emb, retain_cam = ([], 0.0)
        delete_emb, delete_cam = ([], 0.0)
        if testable:
            retain_emb, retain_cam = service.embed_and_compare(masks.retain, centroid, key)
            delete_emb, delete_cam = service.embed_and_compare(masks.delete, centroid, key)

        retain_rs: list[float] = []
        delete_rs: list[float] = []
        rand_retain_emb: list[float] = []
        if testable:
            for seed in range(_FAITH_SEEDS):
                rmask = random_frame_mask(masks.n_frames, masks.k, seed)
                r_ret, r_del = splice_by_frame_mask(waveform, rmask, EXPLAIN_SAMPLE_RATE)
                re_emb, re_sim = service.embed_and_compare(r_ret, centroid, key)
                _, rd_sim = service.embed_and_compare(r_del, centroid, key)
                retain_rs.append(re_sim)
                delete_rs.append(rd_sim)
                if seed == 0:
                    rand_retain_emb = re_emb
        retain_random = sum(retain_rs) / len(retain_rs) if retain_rs else 0.0
        delete_random = sum(delete_rs) / len(delete_rs) if delete_rs else 0.0

        suff = retain_cam - retain_random
        nec = delete_random - delete_cam
        models.append(
            CamFaithModel(
                model_key=key,
                target_user_id=target,
                coverage_pct=coverage_pct,
                original_similarity=original_similarity,
                retain_cam=retain_cam,
                retain_random=retain_random,
                delete_cam=delete_cam,
                delete_random=delete_random,
                sufficiency_margin=suff,
                necessity_margin=nec,
                verdict=_faith_verdict(target, testable, suff, nec),
                retain_segments=masks.segments,
                original_embedding=orig_emb if want_vectors else [],
                retain_embedding=retain_emb if want_vectors else [],
                delete_embedding=delete_emb if want_vectors else [],
                retain_random_embedding=rand_retain_emb if want_vectors else [],
            )
        )

    return CamFaithfulnessResponse(
        models=models,
        coverage_pct=coverage_pct,
        duration_ms=duration_ms,
        n_enrolled_total=n_enrolled,
        model_provenance=service._collect_provenance(),
    )


# -----------------------------------------------------------------------------
# Deepfake lab — generate a clone, then score any uploaded WAV
# -----------------------------------------------------------------------------


@router.get("/spoof/engines", response_model=SpoofEnginesResponse)
def list_spoof_engines(
    service: SpoofGenerationService = Depends(get_spoof_generation_service),
) -> SpoofEnginesResponse:
    """T3 — engines + voices the operator can choose from in DeepfakeLab.

    Each engine's `available` flag reflects whether the backend can
    actually invoke it right now (package importable + binary on PATH
    + network reachable for cloud engines). Unavailable engines are
    still listed so the UI can grey them out + tell the operator why."""
    engines = service.list_engines()
    return SpoofEnginesResponse(
        engines=[
            SpoofEngineInfo(
                id=e.id,
                label=e.label,
                description=e.description,
                requires_network=e.requires_network,
                available=e.available,
                voices=[SpoofVoice(id=v.id, label=v.label, language=v.language) for v in e.voices],
                default_voice=e.default_voice,
            )
            for e in engines
        ],
        default_engine=service.default_engine_id(),
    )


@router.post("/spoof")
async def generate_spoof_sample(
    target_user_id: str = Form(...),
    text: str = Form(...),
    language: str = Form("en"),
    engine: str | None = Form(default=None),
    voice: str | None = Form(default=None),
    reference_sample_id: str | None = Form(default=None),
    audio: UploadFile | None = File(default=None),
    service: SpoofGenerationService = Depends(get_spoof_generation_service),
) -> StreamingResponse:
    """Forge a deepfake clone of `target_user_id`'s enrolled voice
    speaking `text`. Returns an audio/wav blob the caller can play back
    or feed straight to /spoof/test.

    `engine` + `voice` pick the TTS engine + voice. When omitted the
    backend uses its default (first available in priority order)."""
    payload = await audio.read() if audio is not None else None
    if payload == b"":
        raise HTTPException(status_code=400, detail="Audio file is empty")

    try:
        result = service.generate(
            user_id=target_user_id,
            text=text,
            language=language,
            engine=engine,
            voice=voice,
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
            "X-Spoof-Engine": result.engine_id,
            "X-Spoof-Voice": result.voice_id or "",
        },
    )


@router.post("/spoof/test", response_model=SpoofTestResponse)
async def test_spoof_sample(
    audio: UploadFile = File(...),
    service: VerificationService = Depends(get_verification_service),
) -> SpoofTestResponse:
    """Score an arbitrary uploaded WAV against the ensemble detector + the F4
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
    spoof_votes = getattr(service.detector, "last_flagged", 0)
    spoof_total = getattr(service.detector, "last_total", 0)
    spoof_cluster = service._collect_spoof_cluster()
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
        model_provenance=service._collect_provenance(),
        spoof_votes=spoof_votes,
        spoof_total=spoof_total,
        spoof_cluster=spoof_cluster,
    )


def _clamp_unit(value: float) -> float:
    return 0.0 if value < 0.0 else 1.0 if value > 1.0 else value


@router.post("/spoof/batch", response_model=SpoofBatchResponse)
async def generate_spoof_batch(
    req: SpoofBatchRequest,
    spoof: SpoofGenerationService = Depends(get_spoof_generation_service),
    verification: VerificationService = Depends(get_verification_service),
) -> SpoofBatchResponse:
    """Forge many clones of an enrolled target voice and keep only the
    candidates whose speaker-similarity to the target clears the
    threshold. The cloning engine conditions on the target's enrolled
    reference samples, so no uploaded reference is required — generation
    is driven purely by `target_user_id` + text variations."""
    speaker = verification.store.get_speaker(req.target_user_id)
    if speaker is None or not speaker.embedding:
        raise HTTPException(
            status_code=404, detail=f"User '{req.target_user_id}' is not enrolled"
        )

    total_requested = len(req.texts) * req.candidates_per_text
    if total_requested > 64:
        raise HTTPException(
            status_code=400,
            detail="Batch too large: texts × candidates_per_text must be ≤ 64",
        )

    keep_threshold = (
        req.keep_threshold
        if req.keep_threshold is not None
        else verification.similarity_threshold
    )

    # Every engine is a voice-cloning engine now, so the default pick
    # (first available in priority order) already conditions on the target.
    chosen_engine = req.engine or spoof.default_engine_id()

    candidates: list[SpoofBatchCandidate] = []
    generated = 0
    index = 0
    for text in req.texts:
        for _ in range(req.candidates_per_text):
            index += 1
            try:
                result = spoof.generate(
                    user_id=req.target_user_id,
                    text=text,
                    language=req.language,
                    engine=chosen_engine,
                    voice=req.voice,
                )
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except RuntimeError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc

            generated += 1
            try:
                decoded = verification.audio.decode_wav(result.audio_bytes)
                trimmed, _ = verification.audio.trim_to_voice(decoded)
            except (ValueError, WaveError, NoSpeechDetectedError):
                # Unusable audio — count it as generated but never a match.
                candidates.append(
                    SpoofBatchCandidate(
                        index=index, text=text, similarity_to_target=0.0, kept=False,
                        engine_id=result.engine_id, voice_id=result.voice_id,
                        file_name=result.file_name,
                    )
                )
                continue

            embedding = verification.encoder.embed(trimmed.waveform)
            similarity = _clamp_unit(
                verification.encoder.cosine_similarity(speaker.embedding, embedding)
            )
            kept = similarity >= keep_threshold

            deepfake_score: float | None = None
            decision = None
            if req.run_detector:
                deepfake_score = _clamp_unit(verification.detector.detect(trimmed.waveform))
                decision = (
                    "GENUINE" if deepfake_score >= verification.deepfake_threshold else "FAKE"
                )

            candidates.append(
                SpoofBatchCandidate(
                    index=index, text=text,
                    similarity_to_target=similarity, kept=kept,
                    deepfake_score=deepfake_score, decision=decision,
                    engine_id=result.engine_id, voice_id=result.voice_id,
                    file_name=result.file_name,
                    audio_b64=(
                        base64.b64encode(result.audio_bytes).decode("ascii") if kept else None
                    ),
                )
            )

    candidates.sort(key=lambda c: c.similarity_to_target, reverse=True)
    return SpoofBatchResponse(
        target_user_id=req.target_user_id,
        centroid_present=True,
        keep_threshold=keep_threshold,
        requested=total_requested,
        generated=generated,
        kept=sum(1 for c in candidates if c.kept),
        candidates=candidates,
        model_provenance=verification._collect_provenance(),
    )
