"""MLP / logistic-regression detector trained on prosody + MFCC features.

Loads a pickled (scaler, classifier, feature_names) tuple from disk.
Builds the same feature vector as `train_mlp_detector.py` at inference.
"""

from __future__ import annotations

import logging
import pickle
from pathlib import Path

from app.services.detectors.base import Detector, DetectorScore
from app.services.detectors.prosody import ProsodyDetector

logger = logging.getLogger(__name__)


class MLPDetector(Detector):
    name = "mlp"

    def __init__(self, weights_path: Path | None):
        self.weights_path = Path(weights_path) if weights_path else None
        self._model = None
        self._scaler = None
        self._feature_names: list[str] = []
        self._prosody = ProsodyDetector()
        self._loaded = False

    @property
    def available(self) -> bool:
        self._load_lazy()
        return self._model is not None

    def score(self, waveform: list[float], sample_rate: int) -> DetectorScore:
        self._load_lazy()
        if self._model is None or self._scaler is None:
            return DetectorScore(
                name=self.name,
                score=0.5,
                raw_score=0.5,
                available=False,
                meta={"reason": "MLP weights not loaded"},
            )

        prosody_result = self._prosody.score(waveform, sample_rate)
        if not prosody_result.available:
            return DetectorScore(
                name=self.name,
                score=0.5,
                raw_score=0.5,
                available=False,
                meta={"reason": "feature extraction failed", "detail": prosody_result.meta},
            )

        vector = build_feature_vector(prosody_result.meta, self._feature_names)
        try:
            import numpy as np
        except Exception as exc:
            logger.warning("MLPDetector requires numpy: %s", exc)
            return DetectorScore(
                name=self.name, score=0.5, raw_score=0.5, available=False,
                meta={"reason": f"numpy missing: {exc}"},
            )

        scaled = self._scaler.transform(np.array([vector]))
        prob_synthetic = float(self._model.predict_proba(scaled)[0, 1])
        return DetectorScore(
            name=self.name,
            score=prob_synthetic,
            raw_score=prob_synthetic,
            available=True,
            meta={"feature_dim": len(vector)},
        )

    def _load_lazy(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if self.weights_path is None or not self.weights_path.exists():
            logger.info("MLP weights not found at %s — detector disabled", self.weights_path)
            return
        try:
            with self.weights_path.open("rb") as fh:
                payload = pickle.load(fh)
            self._scaler = payload["scaler"]
            self._model = payload["model"]
            self._feature_names = list(payload["feature_names"])
            logger.info("Loaded MLP detector (%d features) from %s", len(self._feature_names), self.weights_path)
        except Exception as exc:
            logger.warning("Failed to load MLP weights from %s: %s", self.weights_path, exc)
            self._model = None
            self._scaler = None


def build_feature_vector(prosody_meta: dict, feature_names: list[str]) -> list[float]:
    """Map prosody-detector meta dict → fixed-length feature vector by name."""
    vector: list[float] = []
    mfcc_means = prosody_meta.get("mfcc_means", [])
    mfcc_stds = prosody_meta.get("mfcc_stds", [])
    for name in feature_names:
        if name.startswith("mfcc_mean_"):
            idx = int(name.rsplit("_", 1)[1])
            vector.append(float(mfcc_means[idx]) if idx < len(mfcc_means) else 0.0)
        elif name.startswith("mfcc_std_"):
            idx = int(name.rsplit("_", 1)[1])
            vector.append(float(mfcc_stds[idx]) if idx < len(mfcc_stds) else 0.0)
        else:
            value = prosody_meta.get(name)
            if value is None:
                vector.append(0.0)
            else:
                try:
                    vector.append(float(value))
                except (TypeError, ValueError):
                    vector.append(0.0)
    return vector


def feature_names() -> list[str]:
    """Canonical feature ordering used by both training and inference."""
    names = [f"mfcc_mean_{i}" for i in range(20)] + [f"mfcc_std_{i}" for i in range(20)]
    names += [
        "praat_jitter_local",
        "praat_shimmer_local",
        "praat_hnr_db",
        "praat_f0_mean_hz",
        "praat_f0_std_hz",
        "voiced_ratio",
        "f0_mean_hz",
        "f0_std_hz",
        "f0_jitter_fallback",
        "silence_ratio",
        "energy_std",
        "zcr_std",
        "spectral_flatness_mean",
        "spectral_flatness_std",
    ]
    return names
