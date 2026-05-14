"""Deepfake detector implementations + ensemble.

Convention: score is P(synthetic), 0.0 = real, 1.0 = deepfake.
"""

from app.services.detectors.aasist import AASISTDetector
from app.services.detectors.base import Detector, DetectorScore
from app.services.detectors.ensemble import EnsembleDetector, EnsembleResult
from app.services.detectors.mlp import MLPDetector
from app.services.detectors.prosody import ProsodyDetector
from app.services.detectors.rawnet2 import RawNet2Detector
from app.services.detectors.wav2vec_aasist import Wav2VecAASISTDetector

__all__ = [
    "AASISTDetector",
    "Detector",
    "DetectorScore",
    "EnsembleDetector",
    "EnsembleResult",
    "MLPDetector",
    "ProsodyDetector",
    "RawNet2Detector",
    "Wav2VecAASISTDetector",
]
