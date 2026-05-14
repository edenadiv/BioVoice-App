"""Application container assembly for the BioVoice backend."""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.calibration import load_calibration
from app.core.config import Settings
from app.services.deepfake_agent import DeepfakeAgent
from app.services.detector import DeepfakeDetectorService
from app.services.detectors import (
    AASISTDetector,
    EnsembleDetector,
    MLPDetector,
    ProsodyDetector,
)
from app.services.llm import build_llm_client
from app.services.speaker_encoder import RedimNetSpeakerEncoder
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
    deepfake_agent: DeepfakeAgent | None


def build_container(settings: Settings) -> AppContainer:
    store = SQLiteStore(
        database_path=settings.database_path,
        reference_samples_path=settings.reference_samples_path,
    )
    detector = DeepfakeDetectorService(weights_path=settings.aasist_weights_path)
    speaker_encoder = RedimNetSpeakerEncoder(weights_path=settings.redimnet_weights_path)
    acoustic_probe = AcousticProbe()
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
    spoof_service = SpoofGenerationService(
        store=store,
        model_path=settings.xtts_model_path,
        output_directory=settings.generated_samples_path,
        default_language=settings.xtts_default_language,
        output_sample_rate=settings.xtts_output_sample_rate,
    )
    ensemble = EnsembleDetector(
        detectors=[
            MLPDetector(weights_path=settings.mlp_detector_weights_path),
            AASISTDetector(weights_path=settings.aasist_weights_path),
            ProsodyDetector(),
        ],
        calibration=load_calibration(settings.detector_calibration_path),
    )

    deepfake_agent: DeepfakeAgent | None = None
    if settings.llm_api_key:
        try:
            llm = build_llm_client(
                provider=settings.llm_provider,
                api_key=settings.llm_api_key,
                model=settings.llm_model,
                base_url=settings.llm_base_url or None,
            )
            deepfake_agent = DeepfakeAgent(llm=llm, ensemble=ensemble)
        except Exception as exc:
            logger.warning("DeepfakeAgent disabled: %s", exc)
    else:
        logger.info("DeepfakeAgent disabled: LLM_API_KEY / ANTHROPIC_API_KEY not set")

    return AppContainer(
        settings=settings,
        store=store,
        detector=detector,
        verification_service=verification_service,
        spoof_service=spoof_service,
        deepfake_agent=deepfake_agent,
    )
