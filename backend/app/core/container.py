"""Application container assembly for the BioVoice backend."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.config import Settings
from app.services.detector import DeepfakeDetectorService
from app.services.speaker_encoder import (
    EcapaSpeakerEncoder,
    RedimNetSpeakerEncoder,
    WeSpeakerResNet293SpeakerEncoder,
)
from app.services.spoof import SpoofGenerationService
from app.services.sub_classifier import AcousticProbe
from app.services.verification import VerificationService
from app.storage.sqlite_store import SQLiteStore

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class AppContainer:
    settings: Settings
    store: SQLiteStore
    detector: DeepfakeDetectorService
    verification_service: VerificationService
    spoof_service: SpoofGenerationService


def build_container(settings: Settings) -> AppContainer:
    store = SQLiteStore(
        database_path=settings.database_path,
        reference_samples_path=settings.reference_samples_path,
    )
    detector = DeepfakeDetectorService(weights_path=settings.aasist_weights_path)
    speaker_encoder = RedimNetSpeakerEncoder(weights_path=settings.redimnet_weights_path)
    comparison_encoders = {}
    if settings.enable_ecapa_comparison:
        try:
            comparison_encoders["ecapa_voxceleb"] = EcapaSpeakerEncoder(savedir=settings.ecapa_savedir)
        except Exception as exc:
            logger.warning("Failed to enable ECAPA comparison model: %s", exc)
    if settings.enable_wespeaker_comparison:
        try:
            comparison_encoders["wespeaker_resnet293_lm"] = WeSpeakerResNet293SpeakerEncoder(
                model_dir=settings.wespeaker_resnet293_dir
            )
        except Exception as exc:
            logger.warning("Failed to enable WeSpeaker ResNet293 comparison model: %s", exc)
    acoustic_probe = AcousticProbe()
    verification_service = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=speaker_encoder,
        sample_rate=settings.sample_rate,
        similarity_threshold=settings.similarity_threshold,
        model_similarity_thresholds={
            "redimnet_b5": settings.redimnet_similarity_threshold,
            "ecapa_voxceleb": settings.ecapa_similarity_threshold,
            "wespeaker_resnet293_lm": settings.wespeaker_similarity_threshold,
        },
        deepfake_threshold=settings.deepfake_threshold,
        min_enrollment_samples=settings.min_enrollment_samples,
        acoustic_probe=acoustic_probe,
        comparison_encoders=comparison_encoders,
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
        spoof_service=spoof_service,
    )
