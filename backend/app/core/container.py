"""Application container assembly for the BioVoice backend."""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import Settings
from app.services.auth import AuthService
from app.services.detector import DeepfakeDetectorService
from app.services.verification import VerificationService
from app.storage.sqlite_store import SQLiteStore


@dataclass(slots=True)
class AppContainer:
    settings: Settings
    store: SQLiteStore
    detector: DeepfakeDetectorService
    verification_service: VerificationService
    auth_service: AuthService


def build_container(settings: Settings) -> AppContainer:
    store = SQLiteStore(database_path=settings.database_path)
    detector = DeepfakeDetectorService(weights_path=settings.aasist_weights_path)
    verification_service = VerificationService(
        store=store,
        detector=detector,
        sample_rate=settings.sample_rate,
        similarity_threshold=settings.similarity_threshold,
        deepfake_threshold=settings.deepfake_threshold,
        min_enrollment_samples=settings.min_enrollment_samples,
    )
    auth_service = AuthService(store=store, verification_service=verification_service)
    return AppContainer(
        settings=settings,
        store=store,
        detector=detector,
        verification_service=verification_service,
        auth_service=auth_service,
    )
