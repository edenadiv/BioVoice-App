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
    # Every comparison encoder we could load, whether or not it currently
    # participates in fusion. PATCH /config toggles participation by moving
    # references between this set and verification_service.comparison_encoders.
    loaded_comparison_encoders: dict


def _load_comparison_encoders(settings: Settings) -> dict:
    """Best-effort load of every comparison encoder whose weights are
    present. Loading is decoupled from participation so the Settings tab
    can toggle a model on/off at runtime without a restart."""
    loaded: dict = {}
    if settings.ecapa_savedir.exists():
        try:
            loaded["ecapa_voxceleb"] = EcapaSpeakerEncoder(savedir=settings.ecapa_savedir)
        except Exception as exc:
            logger.warning("ECAPA comparison model unavailable: %s", exc)
    if settings.wespeaker_resnet293_dir.exists():
        try:
            loaded["wespeaker_resnet293_lm"] = WeSpeakerResNet293SpeakerEncoder(
                model_dir=settings.wespeaker_resnet293_dir
            )
        except Exception as exc:
            logger.warning("WeSpeaker ResNet293 comparison model unavailable: %s", exc)
    return loaded


def build_container(settings: Settings) -> AppContainer:
    store = SQLiteStore(
        database_path=settings.database_path,
        reference_samples_path=settings.reference_samples_path,
    )
    overrides = store.get_config_overrides()

    def ov(key: str, default):
        return overrides.get(key, default)

    detector = DeepfakeDetectorService(weights_path=settings.aasist_weights_path)
    speaker_encoder = RedimNetSpeakerEncoder(weights_path=settings.redimnet_weights_path)

    loaded_comparison_encoders = _load_comparison_encoders(settings)
    enable_ecapa = bool(ov("enable_ecapa_comparison", settings.enable_ecapa_comparison))
    enable_wespeaker = bool(ov("enable_wespeaker_comparison", settings.enable_wespeaker_comparison))
    comparison_encoders: dict = {}
    if enable_ecapa and "ecapa_voxceleb" in loaded_comparison_encoders:
        comparison_encoders["ecapa_voxceleb"] = loaded_comparison_encoders["ecapa_voxceleb"]
    if enable_wespeaker and "wespeaker_resnet293_lm" in loaded_comparison_encoders:
        comparison_encoders["wespeaker_resnet293_lm"] = loaded_comparison_encoders["wespeaker_resnet293_lm"]

    acoustic_probe = AcousticProbe(heads_path=settings.aasist_heads_path)
    verification_service = VerificationService(
        store=store,
        detector=detector,
        speaker_encoder=speaker_encoder,
        sample_rate=settings.sample_rate,
        similarity_threshold=float(ov("similarity_threshold", settings.similarity_threshold)),
        model_similarity_thresholds={
            "redimnet_b5": float(ov("redimnet_similarity_threshold", settings.redimnet_similarity_threshold)),
            "ecapa_voxceleb": float(ov("ecapa_similarity_threshold", settings.ecapa_similarity_threshold)),
            "wespeaker_resnet293_lm": float(ov("wespeaker_similarity_threshold", settings.wespeaker_similarity_threshold)),
        },
        deepfake_threshold=float(ov("deepfake_threshold", settings.deepfake_threshold)),
        min_enrollment_samples=int(ov("min_enrollment_samples", settings.min_enrollment_samples)),
        acoustic_probe=acoustic_probe,
        comparison_encoders=comparison_encoders,
        identify_top_n=int(ov("identify_top_n", 3)),
    )
    spoof_service = SpoofGenerationService(
        store=store,
        model_path=settings.xtts_model_path,
        output_directory=settings.generated_samples_path,
        default_language=settings.xtts_default_language,
        output_sample_rate=settings.xtts_output_sample_rate,
        f5_model_name=settings.f5_model_name,
    )
    return AppContainer(
        settings=settings,
        store=store,
        detector=detector,
        verification_service=verification_service,
        spoof_service=spoof_service,
        loaded_comparison_encoders=loaded_comparison_encoders,
    )
