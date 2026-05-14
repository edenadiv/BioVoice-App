"""Per-detector calibration (Platt scaling + weight + threshold)."""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class DetectorCalibration:
    weight: float = 1.0
    platt_a: float = 1.0  # raw score scale; identity = (a=1, b=0) → no-op via _platt below
    platt_b: float = 0.0
    threshold: float = 0.5

    def calibrate(self, raw_score: float) -> float:
        # When (a, b) == (1, 0) we want identity, not a sigmoid. Skip.
        if self.platt_a == 1.0 and self.platt_b == 0.0:
            return max(0.0, min(1.0, raw_score))
        return _sigmoid(self.platt_a * raw_score + self.platt_b)


@dataclass(slots=True)
class EnsembleCalibration:
    detectors: dict[str, DetectorCalibration] = field(default_factory=dict)
    decision_low: float = 0.35
    decision_high: float = 0.65

    def for_detector(self, name: str) -> DetectorCalibration:
        return self.detectors.get(name, DetectorCalibration())


def load_calibration(path: Path | None) -> EnsembleCalibration:
    if path is None or not Path(path).exists():
        return EnsembleCalibration()
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Failed to load calibration %s: %s — using defaults", path, exc)
        return EnsembleCalibration()

    detectors: dict[str, DetectorCalibration] = {}
    for name, cfg in (data.get("detectors") or {}).items():
        detectors[name] = DetectorCalibration(
            weight=float(cfg.get("weight", 1.0)),
            platt_a=float(cfg.get("platt_a", 1.0)),
            platt_b=float(cfg.get("platt_b", 0.0)),
            threshold=float(cfg.get("threshold", 0.5)),
        )
    return EnsembleCalibration(
        detectors=detectors,
        decision_low=float(data.get("decision_low", 0.35)),
        decision_high=float(data.get("decision_high", 0.65)),
    )


def _sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)
