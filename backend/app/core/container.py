"""Application container assembly for the BioVoice backend."""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import Settings
from app.services.audit import AuditService
from app.services.auth import AuthService
from app.services.detector import DeepfakeDetectorService
from app.services.rate_limit import LoginRateLimiter, RateLimitConfig
from app.services.speaker_encoder import RedimNetSpeakerEncoder
from app.services.spoof import SpoofGenerationService
from app.services.sub_classifier import AcousticProbe
from app.services.verification import VerificationService
from app.storage.sqlite_store import SQLiteStore


@dataclass(slots=True)
class AppContainer:
    settings: Settings
    store: SQLiteStore
    detector: DeepfakeDetectorService
    verification_service: VerificationService
    auth_service: AuthService
    spoof_service: SpoofGenerationService
    audit_service: AuditService


def build_container(settings: Settings) -> AppContainer:
    store = SQLiteStore(
        database_path=settings.database_path,
        reference_samples_path=settings.reference_samples_path,
    )
    detector = DeepfakeDetectorService(weights_path=settings.aasist_weights_path)
    speaker_encoder = RedimNetSpeakerEncoder(weights_path=settings.redimnet_weights_path)
    acoustic_probe = AcousticProbe(heads_path=settings.sub_classifier_heads_path)
    verification_service = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=speaker_encoder,
        sample_rate=settings.sample_rate,
        similarity_threshold=settings.similarity_threshold,
        deepfake_threshold=settings.deepfake_threshold,
        min_enrollment_samples=settings.min_enrollment_samples,
        acoustic_probe=acoustic_probe,
    )
    rate_limiter = LoginRateLimiter(
        store=store,
        config=RateLimitConfig(
            window_seconds=settings.login_rate_window_seconds,
            max_attempts=settings.login_rate_max_attempts,
            lockout_seconds=settings.login_lockout_seconds,
        ),
    )
    audit_service = AuditService(store=store)
    auth_service = AuthService(
        store=store,
        verification_service=verification_service,
        idle_seconds=settings.session_idle_seconds,
        rate_limiter=rate_limiter,
        audit_service=audit_service,
    )
    spoof_service = SpoofGenerationService(
        store=store,
        model_path=settings.xtts_model_path,
        output_directory=settings.generated_samples_path,
        default_language=settings.xtts_default_language,
        output_sample_rate=settings.xtts_output_sample_rate,
    )
    return AppContainer(
        settings=settings,
        store=store,
        detector=detector,
        verification_service=verification_service,
        auth_service=auth_service,
        spoof_service=spoof_service,
        audit_service=audit_service,
    )
