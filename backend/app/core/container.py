"""Application container assembly for the BioVoice backend."""

from __future__ import annotations

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
    # `verified-models` stages ECAPA + WeSpeaker loaders, but ReDimNet
    # remains the only production encoder until those paths are vetted.
    speaker_encoder = RedimNetSpeakerEncoder(weights_path=settings.redimnet_weights_path)
<<<<<<< Updated upstream
    comparison_encoders = {}
    try:
        comparison_encoders["ecapa_voxceleb"] = EcapaSpeakerEncoder(savedir=settings.ecapa_savedir)
    except Exception:
        pass
    try:
        comparison_encoders["wespeaker_resnet293_lm"] = WeSpeakerResNet293SpeakerEncoder(
            model_dir=settings.wespeaker_resnet293_dir
        )
    except Exception:
        pass
=======
<<<<<<< Updated upstream
=======
    comparison_encoders = {}
    if settings.enable_ecapa_comparison:
        try:
            comparison_encoders["ecapa_voxceleb"] = EcapaSpeakerEncoder(savedir=settings.ecapa_savedir)
        except Exception:
            pass
    if settings.enable_wespeaker_comparison:
        try:
            comparison_encoders["wespeaker_resnet293_lm"] = WeSpeakerResNet293SpeakerEncoder(
                model_dir=settings.wespeaker_resnet293_dir
            )
        except Exception:
            pass
>>>>>>> Stashed changes
>>>>>>> Stashed changes
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
        comparison_encoders=comparison_encoders,
    )
    spoof_service = SpoofGenerationService(
        store=store,
        model_path=settings.xtts_model_path,
        output_directory=settings.generated_samples_path,
        default_language=settings.xtts_default_language,
        output_sample_rate=settings.xtts_output_sample_rate,
        openvoice_local_fallback=settings.openvoice_local_fallback,
        openvoice_base_url=settings.openvoice_base_url,
        rvc_base_url=settings.rvc_base_url,
        applio_base_url=settings.applio_base_url,
        rvc_models_path=settings.rvc_models_path,
        applio_models_path=settings.applio_models_path,
    )
    return AppContainer(
        settings=settings,
        store=store,
        detector=detector,
        verification_service=verification_service,
        spoof_service=spoof_service,
    )
